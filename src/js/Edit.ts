/**
 * @file Edit.ts
 * @brief `ModelEditor`: delete objects with their references, undo recorded
 *        deletes, convert node/link types, split and fuse conduits (Python
 *        `openswmm.engine._edit`).
 *
 * The editor works on a {@link Solver} (`solver.editor`, OPENED) or a
 * {@link ModelBuilder} (BUILDING). Mutations invalidate the owner's element
 * views, as in Python.
 *
 * @license  Apache-2.0
 */

import { datetimeToOadate, oadateToDatetime } from "./dates.js";
import { BadHandleError, ElementNotFoundError, raiseForCode } from "./errors.js";
import { checkedAlloc, rawOf, withDouble } from "./mem.js";
import { STRUCTS, type RawApi } from "./raw.js";
import { readStruct } from "./structs.js";
import type { OpenSwmmWasmModule } from "./types.js";

/** What the editor needs from a {@link Solver} or {@link ModelBuilder}. */
export interface EditorOwner {
  readonly handle: number;
  readonly module: OpenSwmmWasmModule;
  /** @internal */
  _bumpGeneration(): void;
}

const REF_TYPE_NAMES: Record<number, string> = {
  0: "node",
  1: "link",
  2: "subcatchment",
  3: "gage",
  4: "table",
  5: "transect",
  6: "inlet_usage",
  7: "ext_inflow",
  8: "dwf_inflow",
  9: "rdii_assign",
  10: "treatment",
  11: "lid_usage",
  12: "snowpack",
  13: "hydrograph",
  14: "pollutant",
  15: "pattern",
  16: "aquifer",
  17: "lid_control",
  18: "street",
  19: "inlet_design",
  20: "landuse",
  21: "control_rule",
};

/** One cross-reference a deletion affects. */
export class ImpactEntry {
  /** Readable name of {@link objType} (`"link"`, `"inlet_usage"`, ...). */
  readonly objTypeName: string;

  constructor(
    /** Referencing object type (`SWMM_RefType`). */
    readonly objType: number,
    /** Zero-based index of the referencing object. */
    readonly objIdx: number,
    /** The reference field, e.g. `"node1"` or `"outlet_node"`. */
    readonly field: string,
    /** True when the referencing object is deleted, false when the reference is cleared. */
    readonly cascaded: boolean,
  ) {
    this.objTypeName = REF_TYPE_NAMES[objType] ?? `type_${objType}`;
  }
}

/** Outcome of a type conversion: the new type, cleared fields and topology warnings. */
export class ConversionResult {
  constructor(
    readonly newType: number,
    readonly clearedFields: string[],
    readonly warnings: string[],
  ) {}
}

/** One object's row of {@link ModelEditor.convertTypes}. */
export class TypeChange {
  constructor(
    readonly sourceType: number,
    readonly status: number,
    readonly dependencyNode: number,
    readonly details: ConversionResult,
  ) {}
}

const records = new FinalizationRegistry<{ raw: RawApi; record: number }>(({ raw, record }) =>
  raw.swmm_delete_record_destroy(record),
);

/**
 * How to undo one recorded delete exactly: every removed row with its
 * original index and every reference the delete cleared or renumbered.
 * {@link restore} puts it all back, at most once. Release it with
 * {@link close} (it is also released when garbage-collected).
 */
export class DeleteRecord {
  private _record: number;
  private _restored = false;

  /** @internal Wrap a record a recorded delete just created; the wrapper owns it. */
  constructor(
    private readonly _owner: EditorOwner,
    private readonly _raw: RawApi,
    record: number,
  ) {
    this._record = record;
    if (record) records.register(this, { raw: _raw, record }, this);
  }

  /** True until {@link restore} succeeds or {@link close} is called. */
  get restorable(): boolean {
    return this._record !== 0 && !this._restored;
  }

  /**
   * Undo the delete. The engine refuses, changing nothing, when the model no
   * longer matches the state the delete left; the record then stays
   * restorable. A restore invalidates the owner's element views.
   *
   * @throws RangeError if the record was already restored or closed.
   */
  restore(): void {
    if (this._restored) throw new RangeError("This delete record was already restored.");
    if (!this._record) throw new RangeError("This delete record was closed.");
    let handle: number;
    try {
      handle = this._owner.handle;
    } catch {
      handle = 0;
    }
    if (!handle) throw new BadHandleError("Engine has been destroyed");
    raiseForCode(this._raw.swmm_delete_record_restore(handle, this._record));
    this._restored = true;
    this._owner._bumpGeneration();
  }

  /** Release the native record; it can no longer be restored. Repeatable. */
  close(): void {
    if (this._record) {
      records.unregister(this);
      this._raw.swmm_delete_record_destroy(this._record);
      this._record = 0;
    }
  }
}

type IndexKind =
  | "node"
  | "link"
  | "subcatch"
  | "gage"
  | "table"
  | "pollutant"
  | "pattern"
  | "aquifer"
  | "snowpack"
  | "lid"
  | "street"
  | "inlet"
  | "landuse";

type Key = number | string;

/** Options of {@link ModelEditor.convertTypes}. */
export interface ConvertTypesOptions {
  /** Convert (true) or preview (false). */
  apply?: boolean;
  /** Inlet design for inlet targets; -2 previews topology alone. */
  design?: number;
  /** Capture node for inlet targets. */
  capture?: number;
  /** Inlet placement for inlet targets. */
  placement?: number;
}

/** Delete objects, undo recorded deletes, convert types, split and fuse conduits. */
export class ModelEditor {
  private readonly _mod: OpenSwmmWasmModule;
  private readonly _raw: RawApi;

  constructor(private readonly _owner: EditorOwner) {
    this._mod = _owner.module;
    this._raw = rawOf(this._mod);
    void this._h;
  }

  /** @internal */
  private get _h(): number {
    const h = this._owner.handle;
    if (!h) throw new BadHandleError("Engine has been destroyed");
    return h;
  }

  /** @internal A name resolves through the engine's index; a number is used as given. */
  private _idx(kind: IndexKind, key: Key): number {
    if (typeof key !== "string") return key;
    const i = this._raw[`swmm_${kind}_index`](this._h, key);
    if (i < 0) throw new ElementNotFoundError(key);
    return i;
  }

  /**
   * @internal Fill an `SWMM_ImpactReport`, convert it and free it. `extra`
   * zeroed bytes follow the report (a recorded delete's record pointer).
   */
  private _report(call: (report: number) => number, extra = 0): ImpactEntry[] {
    const mod = this._mod;
    const size = STRUCTS.SWMM_ImpactReport.size;
    const p = checkedAlloc(mod, size + extra);
    mod.HEAPU8.fill(0, p, p + size + extra);
    try {
      raiseForCode(call(p));
      const report = readStruct(mod, "SWMM_ImpactReport", p) as {
        entries: number;
        n_entries: number;
      };
      const entrySize = STRUCTS.SWMM_ImpactEntry.size;
      const entries: ImpactEntry[] = [];
      for (let i = 0; report.entries && i < report.n_entries; i++) {
        const e = readStruct(mod, "SWMM_ImpactEntry", report.entries + i * entrySize) as {
          obj_type: number;
          obj_idx: number;
          field: string;
          cascaded: number;
        };
        entries.push(new ImpactEntry(e.obj_type, e.obj_idx, e.field, e.cascaded !== 0));
      }
      return entries;
    } finally {
      this._raw.swmm_impact_report_free(p);
      mod._free(p);
    }
  }

  /** @internal Read an `SWMM_ConversionResult` at `ptr` and free its contents. */
  private _conversion(ptr: number): ConversionResult {
    const mod = this._mod;
    try {
      const r = readStruct(mod, "SWMM_ConversionResult", ptr) as {
        new_type: number;
        cleared_fields: number;
        n_cleared: number;
        warnings: number;
        n_warnings: number;
      };
      const strings = (array: number, n: number) => {
        const out: string[] = [];
        for (let i = 0; array && i < n; i++) {
          const s = mod.HEAPU32[(array >> 2) + i];
          if (s) out.push(mod.UTF8ToString(s));
        }
        return out;
      };
      return new ConversionResult(
        r.new_type,
        strings(r.cleared_fields, r.n_cleared),
        strings(r.warnings, r.n_warnings),
      );
    } finally {
      this._raw.swmm_conversion_result_free(ptr);
    }
  }

  /** @internal */
  private _convert(call: (h: number, result: number) => number): ConversionResult {
    const mod = this._mod;
    const size = STRUCTS.SWMM_ConversionResult.size;
    const p = checkedAlloc(mod, size);
    mod.HEAPU8.fill(0, p, p + size);
    try {
      this._owner._bumpGeneration();
      const rc = call(this._h, p);
      if (rc) {
        this._raw.swmm_conversion_result_free(p);
        raiseForCode(rc);
      }
      return this._conversion(p);
    } finally {
      mod._free(p);
    }
  }

  /** @internal Copy indices into the heap for a batch call. */
  private _batch<T>(
    kind: IndexKind,
    keys: Iterable<Key>,
    call: (h: number, indices: number, n: number) => T,
  ): T {
    const indices = Array.from(keys, (k) => this._idx(kind, k));
    const mod = this._mod;
    const p = checkedAlloc(mod, Math.max(4 * indices.length, 4));
    try {
      mod.HEAP32.set(indices, p >> 2);
      return call(this._h, p, indices.length);
    } finally {
      mod._free(p);
    }
  }

  /** @internal A delete without a record; the owner's views are invalidated first. */
  private _delete(call: (h: number, report: number) => number): ImpactEntry[] {
    this._owner._bumpGeneration();
    return this._report((r) => call(this._h, r));
  }

  /** @internal A recorded delete: the report plus the record that undoes it. */
  private _recorded(
    call: (h: number, report: number, record: number) => number,
    changed = true,
  ): [ImpactEntry[], DeleteRecord] {
    let record = 0;
    const size = STRUCTS.SWMM_ImpactReport.size;
    const impacts = this._report((r) => {
      const rc = call(this._h, r, r + size);
      record = this._mod.HEAPU32[(r + size) >> 2];
      if (!rc && changed) this._owner._bumpGeneration();
      return rc;
    }, 4);
    return [impacts, new DeleteRecord(this._owner, this._raw, record)];
  }

  // ---- batch deletes ---------------------------------------------------------

  /**
   * Delete a batch named by pre-edit ids or indices; all are validated before
   * any change. Duplicates are ignored. Returns the aggregate cascade report.
   */
  deleteNodes(keys: Iterable<Key>): ImpactEntry[] {
    return this._batchDelete("node", keys, this._raw.swmm_node_delete_many);
  }

  deleteLinks(keys: Iterable<Key>): ImpactEntry[] {
    return this._batchDelete("link", keys, this._raw.swmm_link_delete_many);
  }

  deleteSubcatchments(keys: Iterable<Key>): ImpactEntry[] {
    return this._batchDelete("subcatch", keys, this._raw.swmm_subcatch_delete_many);
  }

  deleteGages(keys: Iterable<Key>): ImpactEntry[] {
    return this._batchDelete("gage", keys, this._raw.swmm_gage_delete_many);
  }

  /** @internal */
  private _batchDelete(
    kind: IndexKind,
    keys: Iterable<Key>,
    fn: (h: number, indices: number, n: number, report: number) => number,
  ): ImpactEntry[] {
    return this._batch(kind, keys, (h, p, n) => {
      const impacts = this._report((r) => fn(h, p, n, r));
      if (n) this._owner._bumpGeneration();
      return impacts;
    });
  }

  // ---- recorded (undoable) deletes ----------------------------------------------

  /** Delete a node as {@link deleteNode} does and record how to undo it. */
  deleteNodeRecorded(key: Key): [ImpactEntry[], DeleteRecord] {
    const i = this._idx("node", key);
    return this._recorded((h, r, rec) => this._raw.swmm_node_delete_recorded(h, i, r, rec));
  }

  deleteLinkRecorded(key: Key): [ImpactEntry[], DeleteRecord] {
    const i = this._idx("link", key);
    return this._recorded((h, r, rec) => this._raw.swmm_link_delete_recorded(h, i, r, rec));
  }

  deleteSubcatchRecorded(key: Key): [ImpactEntry[], DeleteRecord] {
    const i = this._idx("subcatch", key);
    return this._recorded((h, r, rec) => this._raw.swmm_subcatch_delete_recorded(h, i, r, rec));
  }

  deleteGageRecorded(key: Key): [ImpactEntry[], DeleteRecord] {
    const i = this._idx("gage", key);
    return this._recorded((h, r, rec) => this._raw.swmm_gage_delete_recorded(h, i, r, rec));
  }

  /**
   * Delete a batch as {@link deleteNodes} does; one record restores every
   * node at its original index. An empty batch returns a record that does
   * nothing.
   */
  deleteNodesRecorded(keys: Iterable<Key>): [ImpactEntry[], DeleteRecord] {
    return this._batchRecorded("node", keys, this._raw.swmm_node_delete_many_recorded);
  }

  deleteLinksRecorded(keys: Iterable<Key>): [ImpactEntry[], DeleteRecord] {
    return this._batchRecorded("link", keys, this._raw.swmm_link_delete_many_recorded);
  }

  deleteSubcatchmentsRecorded(keys: Iterable<Key>): [ImpactEntry[], DeleteRecord] {
    return this._batchRecorded("subcatch", keys, this._raw.swmm_subcatch_delete_many_recorded);
  }

  deleteGagesRecorded(keys: Iterable<Key>): [ImpactEntry[], DeleteRecord] {
    return this._batchRecorded("gage", keys, this._raw.swmm_gage_delete_many_recorded);
  }

  /** @internal */
  private _batchRecorded(
    kind: IndexKind,
    keys: Iterable<Key>,
    fn: (h: number, indices: number, n: number, report: number, record: number) => number,
  ): [ImpactEntry[], DeleteRecord] {
    return this._batch(kind, keys, (_h, p, n) =>
      this._recorded((h, r, rec) => fn(h, p, n, r, rec), n > 0),
    );
  }

  // ---- impact analysis (read-only) -------------------------------------------------

  /** Objects that reference a node, without deleting it. */
  analyzeNodeImpact(key: Key): ImpactEntry[] {
    return this._analyze("node", key, this._raw.swmm_node_analyze_impact);
  }

  analyzeLinkImpact(key: Key): ImpactEntry[] {
    return this._analyze("link", key, this._raw.swmm_link_analyze_impact);
  }

  analyzeSubcatchImpact(key: Key): ImpactEntry[] {
    return this._analyze("subcatch", key, this._raw.swmm_subcatch_analyze_impact);
  }

  analyzeGageImpact(key: Key): ImpactEntry[] {
    return this._analyze("gage", key, this._raw.swmm_gage_analyze_impact);
  }

  analyzeTableImpact(key: Key): ImpactEntry[] {
    return this._analyze("table", key, this._raw.swmm_table_analyze_impact);
  }

  analyzeTransectImpact(idx: number): ImpactEntry[] {
    return this._report((r) => this._raw.swmm_transect_analyze_impact(this._h, idx, r));
  }

  analyzePollutantImpact(key: Key): ImpactEntry[] {
    return this._analyze("pollutant", key, this._raw.swmm_pollutant_analyze_impact);
  }

  analyzePatternImpact(key: Key): ImpactEntry[] {
    return this._analyze("pattern", key, this._raw.swmm_pattern_analyze_impact);
  }

  analyzeAquiferImpact(key: Key): ImpactEntry[] {
    return this._analyze("aquifer", key, this._raw.swmm_aquifer_analyze_impact);
  }

  analyzeSnowpackImpact(key: Key): ImpactEntry[] {
    return this._analyze("snowpack", key, this._raw.swmm_snowpack_analyze_impact);
  }

  analyzeLidImpact(key: Key): ImpactEntry[] {
    return this._analyze("lid", key, this._raw.swmm_lid_analyze_impact);
  }

  analyzeStreetImpact(key: Key): ImpactEntry[] {
    return this._analyze("street", key, this._raw.swmm_street_analyze_impact);
  }

  analyzeInletImpact(key: Key): ImpactEntry[] {
    return this._analyze("inlet", key, this._raw.swmm_inlet_analyze_impact);
  }

  analyzeLanduseImpact(key: Key): ImpactEntry[] {
    return this._analyze("landuse", key, this._raw.swmm_landuse_analyze_impact);
  }

  /** Objects that reference a unit-hydrograph group (groups are keyed by name). */
  analyzeHydrographImpact(uhName: string): ImpactEntry[] {
    return this._report((r) => this._raw.swmm_hydrograph_analyze_impact(this._h, uhName, r));
  }

  /** @internal */
  private _analyze(
    kind: IndexKind,
    key: Key,
    fn: (h: number, idx: number, report: number) => number,
  ): ImpactEntry[] {
    const i = this._idx(kind, key);
    return this._report((r) => fn(this._h, i, r));
  }

  // ---- deletes --------------------------------------------------------------------

  /**
   * Delete a node: links that end at it are deleted, other references are
   * cleared (-1) and higher indices shift down. Returns what changed.
   */
  deleteNode(key: Key): ImpactEntry[] {
    return this._deleteOne("node", key, this._raw.swmm_node_delete);
  }

  deleteLink(key: Key): ImpactEntry[] {
    return this._deleteOne("link", key, this._raw.swmm_link_delete);
  }

  deleteSubcatch(key: Key): ImpactEntry[] {
    return this._deleteOne("subcatch", key, this._raw.swmm_subcatch_delete);
  }

  deleteGage(key: Key): ImpactEntry[] {
    return this._deleteOne("gage", key, this._raw.swmm_gage_delete);
  }

  deleteTable(key: Key): ImpactEntry[] {
    return this._deleteOne("table", key, this._raw.swmm_table_delete);
  }

  deleteTransect(idx: number): ImpactEntry[] {
    return this._delete((h, r) => this._raw.swmm_transect_delete(h, idx, r));
  }

  deletePollutant(key: Key): ImpactEntry[] {
    return this._deleteOne("pollutant", key, this._raw.swmm_pollutant_delete);
  }

  deletePattern(key: Key): ImpactEntry[] {
    return this._deleteOne("pattern", key, this._raw.swmm_pattern_delete);
  }

  deleteAquifer(key: Key): ImpactEntry[] {
    return this._deleteOne("aquifer", key, this._raw.swmm_aquifer_delete);
  }

  deleteSnowpack(key: Key): ImpactEntry[] {
    return this._deleteOne("snowpack", key, this._raw.swmm_snowpack_delete);
  }

  deleteLid(key: Key): ImpactEntry[] {
    return this._deleteOne("lid", key, this._raw.swmm_lid_delete);
  }

  deleteStreet(key: Key): ImpactEntry[] {
    return this._deleteOne("street", key, this._raw.swmm_street_delete);
  }

  deleteInlet(key: Key): ImpactEntry[] {
    return this._deleteOne("inlet", key, this._raw.swmm_inlet_delete);
  }

  deleteLanduse(key: Key): ImpactEntry[] {
    return this._deleteOne("landuse", key, this._raw.swmm_landuse_delete);
  }

  /** Delete a unit-hydrograph group by name. */
  deleteHydrograph(uhName: string): ImpactEntry[] {
    return this._delete((h, r) => this._raw.swmm_hydrograph_delete(h, uhName, r));
  }

  /** @internal */
  private _deleteOne(
    kind: IndexKind,
    key: Key,
    fn: (h: number, idx: number, report: number) => number,
  ): ImpactEntry[] {
    const i = this._idx(kind, key);
    return this._delete((h, r) => fn(h, i, r));
  }

  // ---- type conversion ------------------------------------------------------------

  /**
   * Convert a node to another {@link NodeType} in place: common properties
   * stay, type-specific ones are cleared and new defaults applied.
   */
  convertNode(key: Key, newType: number): ConversionResult {
    const i = this._idx("node", key);
    return this._convert((h, r) => this._raw.swmm_node_convert(h, i, newType, r));
  }

  /** Convert a link to another {@link LinkType} in place. */
  convertLink(key: Key, newType: number): ConversionResult {
    const i = this._idx("link", key);
    return this._convert((h, r) => this._raw.swmm_link_convert(h, i, newType, r));
  }

  /**
   * Preview or convert several nodes (`nodes = true`) or links to one type.
   * Each object gets its own {@link TypeChange}; a refused object is left
   * unchanged while the others convert. Indices must be unique.
   */
  convertTypes(
    nodes: boolean,
    target: number,
    indices: Iterable<number>,
    { apply = true, design = -1, capture = -1, placement = 0 }: ConvertTypesOptions = {},
  ): TypeChange[] {
    const idx = Array.from(indices, (i) => Math.trunc(i));
    const n = idx.length;
    const mod = this._mod;
    const rowSize = STRUCTS.SWMM_TypeChange.size;
    const detailsAt = STRUCTS.SWMM_TypeChange.fields.details.offset;
    const ip = checkedAlloc(mod, Math.max(4 * n, 4));
    const rows = checkedAlloc(mod, Math.max(rowSize * n, rowSize));
    mod.HEAPU8.fill(0, rows, rows + rowSize * Math.max(n, 1));
    try {
      mod.HEAP32.set(idx, ip >> 2);
      if (apply) this._owner._bumpGeneration();
      const rc = this._raw.swmm_convert_types(
        this._h,
        nodes ? 1 : 0,
        target,
        n ? ip : 0,
        n,
        design,
        capture,
        placement,
        apply ? 1 : 0,
        n ? rows : 0,
      );
      if (rc) {
        for (let i = 0; i < n; i++)
          this._raw.swmm_conversion_result_free(rows + i * rowSize + detailsAt);
        raiseForCode(rc);
      }
      return idx.map((_, i) => {
        const row = rows + i * rowSize;
        const h = mod.HEAP32;
        return new TypeChange(
          h[row >> 2],
          h[(row + 4) >> 2],
          h[(row + 8) >> 2],
          this._conversion(row + detailsAt),
        );
      });
    } finally {
      mod._free(ip);
      mod._free(rows);
    }
  }

  // ---- virtual and inlet junctions --------------------------------------------------

  /** Set or clear a node's virtual-junction flag (setting validates the rules). */
  setNodeVirtual(key: Key, makeVirtual = true): void {
    const i = this._idx("node", key);
    raiseForCode(this._raw.swmm_node_set_virtual(this._h, i, makeVirtual ? 1 : 0));
  }

  /**
   * Split a conduit at fraction `t` (0 < t < 1) of its length, inserting a
   * node. Returns the new node's and new link's indices.
   */
  splitConduit(
    key: Key,
    t: number,
    newNodeName: string,
    newLinkName: string,
    makeVirtual = false,
  ): [number, number] {
    const i = this._idx("link", key);
    return this._split((h, node, link) =>
      this._raw.swmm_conduit_split(
        h,
        i,
        t,
        newNodeName,
        newLinkName,
        makeVirtual ? 1 : 0,
        node,
        link,
      ),
    );
  }

  /** Re-fuse a virtual junction's two conduits; returns the surviving link's index. */
  fuseVirtualJunction(key: Key): number {
    const i = this._idx("node", key);
    return this._fuse((h, p) => this._raw.swmm_virtual_junction_fuse(h, i, p));
  }

  /** Promote a node to an inlet junction, or demote it back. */
  setNodeInlet(key: Key, makeInlet = true): void {
    const i = this._idx("node", key);
    raiseForCode(this._raw.swmm_node_set_inlet(this._h, i, makeInlet ? 1 : 0));
  }

  /**
   * Split a street conduit, inserting an inlet junction with design
   * `inletId` delivering to `captureNode`. Returns the new node's and new
   * link's indices.
   */
  splitConduitInlet(
    key: Key,
    t: number,
    newNodeName: string,
    newLinkName: string,
    inletId: string,
    captureNode: string,
  ): [number, number] {
    const i = this._idx("link", key);
    return this._split((h, node, link) =>
      this._raw.swmm_conduit_split_inlet(
        h,
        i,
        t,
        newNodeName,
        newLinkName,
        inletId,
        captureNode,
        node,
        link,
      ),
    );
  }

  /** Re-fuse an inlet junction's two conduits; returns the surviving link's index. */
  fuseInletJunction(key: Key): number {
    const i = this._idx("node", key);
    return this._fuse((h, p) => this._raw.swmm_inlet_junction_fuse(h, i, p));
  }

  /** @internal */
  private _split(call: (h: number, node: number, link: number) => number): [number, number] {
    const mod = this._mod;
    const p = checkedAlloc(mod, 8);
    try {
      mod.HEAP32[p >> 2] = -1;
      mod.HEAP32[(p + 4) >> 2] = -1;
      this._owner._bumpGeneration();
      raiseForCode(call(this._h, p, p + 4));
      return [mod.HEAP32[p >> 2], mod.HEAP32[(p + 4) >> 2]];
    } finally {
      mod._free(p);
    }
  }

  /** @internal */
  private _fuse(call: (h: number, surviving: number) => number): number {
    const mod = this._mod;
    const p = checkedAlloc(mod, 4);
    try {
      mod.HEAP32[p >> 2] = -1;
      this._owner._bumpGeneration();
      raiseForCode(call(this._h, p));
      return mod.HEAP32[p >> 2];
    } finally {
      mod._free(p);
    }
  }

  // ---- counts and dates -----------------------------------------------------------

  get nodeCount(): number {
    return this._raw.swmm_node_count(this._h);
  }

  get linkCount(): number {
    return this._raw.swmm_link_count(this._h);
  }

  get subcatchCount(): number {
    return this._raw.swmm_subcatch_count(this._h);
  }

  get gageCount(): number {
    return this._raw.swmm_gage_count(this._h);
  }

  /** Time series plus curves. */
  get tableCount(): number {
    return this._raw.swmm_table_count(this._h);
  }

  /** Simulation start (UTC wall clock). */
  get startDatetime(): Date {
    return this._date(this._raw.swmm_options_get_start_date);
  }
  set startDatetime(value: Date) {
    raiseForCode(this._raw.swmm_options_set_start_date(this._h, datetimeToOadate(value)));
  }

  /** Simulation end (UTC wall clock). */
  get endDatetime(): Date {
    return this._date(this._raw.swmm_options_get_end_date);
  }
  set endDatetime(value: Date) {
    raiseForCode(this._raw.swmm_options_set_end_date(this._h, datetimeToOadate(value)));
  }

  /** Report start (UTC wall clock). */
  get reportStartDatetime(): Date {
    return this._date(this._raw.swmm_options_get_report_start);
  }
  set reportStartDatetime(value: Date) {
    raiseForCode(this._raw.swmm_options_set_report_start(this._h, datetimeToOadate(value)));
  }

  /** @internal */
  private _date(fn: (h: number, out: number) => number): Date {
    return oadateToDatetime(withDouble(this._mod, (p) => fn(this._h, p)));
  }
}
