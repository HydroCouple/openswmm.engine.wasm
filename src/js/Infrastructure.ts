/**
 * @file Infrastructure.ts
 * @brief `solver.infrastructure`: transects, street cross-sections, inlet
 *        designs and placements, and LID controls with their storage-node
 *        stacks and subcatchment placements (Python
 *        `openswmm.engine._infrastructure`).
 *
 * Python's dict records are objects with camelCase keys here
 * (`t_crown` → `tCrown`); records read from one method are accepted by its
 * counterpart (`getDesign` → `setDesign`, `nodeSnapshot` → `replaceNode`,
 * `usageRecord` → `replaceUsages`).
 *
 * @license  Apache-2.0
 */

import { resolveIndex } from "./element.js";
import { InletPlacement, type InletHostKind, type LidType } from "./enums.js";
import { ElementNotFoundError, raiseForCode } from "./errors.js";
import { LidLayerTreatment, LidNodeLayer, LidNodeLayerKind } from "./LidNodes.js";
import { checkedAlloc, withCString, withDouble, withInt } from "./mem.js";
import { STRUCTS } from "./raw.js";
import { readStruct, withStruct, withStructs, writeStruct, type StructValue } from "./structs.js";
import type { Solver } from "./Solver.js";
import type { OpenSwmmWasmModule } from "./types.js";
import { SolverView } from "./view.js";

type Key = number | string;
type Kind = "transect" | "street" | "inlet" | "lid";

const camelKey = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const snakeKey = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Struct fields (snake_case) → a camelCase record. */
function camel<T>(value: StructValue): T {
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [camelKey(k), v])) as T;
}

/** A camelCase record → struct fields (snake_case). */
function snake(value: object): StructValue {
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [snakeKey(k), v])) as StructValue;
}

/** Call `fn` with `n` zeroed `double*` outputs and return their values. */
function doubles(mod: OpenSwmmWasmModule, n: number, fn: (ptrs: number[]) => number): number[] {
  const p = checkedAlloc(mod, 8 * n);
  try {
    mod.HEAPF64.fill(0, p >> 3, (p >> 3) + n);
    const ptrs = Array.from({ length: n }, (_, i) => p + 8 * i);
    raiseForCode(fn(ptrs));
    return ptrs.map((q) => mod.HEAPF64[q >> 3]);
  } finally {
    mod._free(p);
  }
}

/** An id-addressed infrastructure family (Python's per-family views). */
abstract class NamedFamily extends SolverView {
  /** @internal */
  protected abstract readonly _kind: Kind;

  get length(): number {
    return this._raw[`swmm_${this._kind}_count`](this._h);
  }

  /** Zero-based index of an id. @throws {@link ElementNotFoundError} if absent. */
  getIndex(id: string): number {
    const i = this._raw[`swmm_${this._kind}_index`](this._h, id);
    if (i < 0) throw new ElementNotFoundError(id);
    return i;
  }

  getId(idx: number): string {
    return this._raw[`swmm_${this._kind}_id`](this._h, idx) ?? "";
  }

  *[Symbol.iterator](): Iterator<string> {
    const n = this.length;
    for (let i = 0; i < n; i++) yield this.getId(i);
  }

  has(key: Key): boolean {
    if (typeof key === "string") return this._raw[`swmm_${this._kind}_index`](this._h, key) >= 0;
    return Number.isInteger(key) && key >= 0 && key < this.length;
  }

  /** Rename, updating stored references. */
  rename(key: Key, newId: string): void {
    const idx = typeof key === "string" ? this.getIndex(key) : key;
    raiseForCode(this._raw[`swmm_${this._kind}_rename`](this._h, idx, newId));
    this._solver._bumpGeneration();
  }

  /** @internal Index of `key`, range-checked (Python `_resolve_index`). */
  protected _index(key: Key): number {
    if (typeof key === "string") return this.getIndex(key);
    const n = this.length;
    if (!Number.isInteger(key) || key < 0 || key >= n) {
      throw new RangeError(`${this._kind} index ${key} out of range [0, ${n})`);
    }
    return key;
  }
}

// ---- transects ----------------------------------------------------------------

/** `solver.infrastructure.transects`: natural-channel cross-sections. */
export class Transects extends NamedFamily {
  protected readonly _kind = "transect";

  /** Add a transect; returns its index. */
  add(transectId: string): number {
    raiseForCode(this._raw.swmm_transect_add(this._h, transectId));
    this._solver._bumpGeneration();
    return this.length - 1;
  }

  /** @internal Index or id; negative indices count from the end. */
  private _resolve(key: Key): number {
    if (typeof key === "string") return this.getIndex(key);
    const n = this.length;
    const idx = key < 0 ? key + n : key;
    if (!(idx >= 0 && idx < n)) throw new RangeError(String(key));
    return idx;
  }

  override has(key: Key): boolean {
    try {
      this._resolve(key);
      return true;
    } catch {
      return false;
    }
  }

  /** Remove a transect, clearing the sites that referenced it. */
  remove(key: Key): void {
    const idx = this._resolve(key);
    raiseForCode(this._raw.swmm_transect_remove(this._h, idx));
    this._solver._bumpGeneration();
  }

  override rename(key: Key, newId: string): void {
    const idx = this._resolve(key);
    raiseForCode(this._raw.swmm_transect_rename(this._h, idx, newId));
    this._solver._bumpGeneration();
  }

  setRoughness(idx: number, nLeft: number, nRight: number, nChannel: number): void {
    raiseForCode(this._raw.swmm_transect_set_roughness(this._h, idx, nLeft, nRight, nChannel));
  }

  /** `[nLeft, nRight, nChannel]`. */
  getRoughness(idx: number): [number, number, number] {
    const [l, r, c] = doubles(this._mod, 3, ([a, b, d]) =>
      this._raw.swmm_transect_get_roughness(this._h, idx, a, b, d),
    );
    return [l, r, c];
  }

  /** Append a `(station, elevation)` point. */
  addStation(idx: number, station: number, elevation: number): void {
    raiseForCode(this._raw.swmm_transect_add_station(this._h, idx, station, elevation));
  }

  stationCount(idx: number): number {
    return this._raw.swmm_transect_get_station_count(this._h, idx);
  }

  /** `[station, elevation]` of one point. */
  getStation(idx: number, stationIdx: number): [number, number] {
    const [s, e] = doubles(this._mod, 2, ([a, b]) =>
      this._raw.swmm_transect_get_station(this._h, idx, stationIdx, a, b),
    );
    return [s, e];
  }

  /** Every `[station, elevation]` point. */
  stations(idx: number): [number, number][] {
    return Array.from({ length: this.stationCount(idx) }, (_, i) => this.getStation(idx, i));
  }

  clearStations(idx: number): void {
    raiseForCode(this._raw.swmm_transect_clear_stations(this._h, idx));
  }

  /** `[left, right]` bank stations. */
  getBankStations(idx: number): [number, number] {
    const [l, r] = doubles(this._mod, 2, ([a, b]) =>
      this._raw.swmm_transect_get_bank_stations(this._h, idx, a, b),
    );
    return [l, r];
  }

  setBankStations(idx: number, left: number, right: number): void {
    raiseForCode(this._raw.swmm_transect_set_bank_stations(this._h, idx, left, right));
  }

  /** `[left, right]` encroachment stations. */
  getEncroachmentStations(idx: number): [number, number] {
    const [l, r] = doubles(this._mod, 2, ([a, b]) =>
      this._raw.swmm_transect_get_encroachment_stations(this._h, idx, a, b),
    );
    return [l, r];
  }

  setEncroachmentStations(idx: number, left: number, right: number): void {
    raiseForCode(this._raw.swmm_transect_set_encroachment_stations(this._h, idx, left, right));
  }

  /** `[nFactor, xFactor, yFactor]` geometry modifiers. */
  getModifiers(idx: number): [number, number, number] {
    const [n, x, y] = doubles(this._mod, 3, ([a, b, c]) =>
      this._raw.swmm_transect_get_modifiers(this._h, idx, a, b, c),
    );
    return [n, x, y];
  }

  setModifiers(idx: number, nFactor: number, xFactor: number, yFactor: number): void {
    raiseForCode(this._raw.swmm_transect_set_modifiers(this._h, idx, nFactor, xFactor, yFactor));
  }

  getComments(idx: number): string {
    return withCString(this._mod, 256, (buf, len) =>
      this._raw.swmm_transect_get_comments(this._h, idx, buf, len),
    );
  }

  setComments(idx: number, text: string): void {
    raiseForCode(this._raw.swmm_transect_set_comments(this._h, idx, text));
  }
}

// ---- streets ------------------------------------------------------------------

/** Geometry and roughness of a street cross-section. */
export interface StreetParams {
  tCrown: number;
  hCurb: number;
  sx: number;
  nRoad: number;
  gutterDepres: number;
  gutterWidth: number;
  sides: number;
  backWidth: number;
  backSlope: number;
  backN: number;
}

/** `solver.infrastructure.streets`: street cross-sections. */
export class Streets extends NamedFamily {
  protected readonly _kind = "street";

  /** Add a street cross-section; returns its index. */
  add(streetId: string): number {
    raiseForCode(this._raw.swmm_street_add(this._h, streetId));
    this._solver._bumpGeneration();
    return this.length - 1;
  }

  /** Set a street's geometry; gutter, sides (2) and backing default as in Python. */
  setParams(
    idx: number,
    {
      tCrown,
      hCurb,
      sx,
      nRoad,
      gutterDepres = 0,
      gutterWidth = 0,
      sides = 2,
      backWidth = 0,
      backSlope = 0,
      backN = 0,
    }: Pick<StreetParams, "tCrown" | "hCurb" | "sx" | "nRoad"> & Partial<StreetParams>,
  ): void {
    raiseForCode(
      this._raw.swmm_street_set_params(
        this._h,
        idx,
        tCrown,
        hCurb,
        sx,
        nRoad,
        gutterDepres,
        gutterWidth,
        sides,
        backWidth,
        backSlope,
        backN,
      ),
    );
  }

  /** The street's geometry, in the units it was given (inverse of {@link setParams}). */
  getParams(idx: number): StreetParams {
    const mod = this._mod;
    const p = checkedAlloc(mod, 80);
    try {
      mod.HEAPU8.fill(0, p, p + 80);
      const d = (i: number) => p + 8 * i;
      raiseForCode(
        this._raw.swmm_street_get_params(
          this._h,
          idx,
          d(0),
          d(1),
          d(2),
          d(3),
          d(4),
          d(5),
          d(6),
          d(7),
          d(8),
          d(9),
        ),
      );
      const f = (i: number) => mod.HEAPF64[d(i) >> 3];
      return {
        tCrown: f(0),
        hCurb: f(1),
        sx: f(2),
        nRoad: f(3),
        gutterDepres: f(4),
        gutterWidth: f(5),
        sides: mod.HEAP32[d(6) >> 2],
        backWidth: f(7),
        backSlope: f(8),
        backN: f(9),
      };
    } finally {
      mod._free(p);
    }
  }
}

// ---- inlets -------------------------------------------------------------------

/** Grate/slotted inlet dimensions (Python `Inlets.set_params`). */
export interface InletParams {
  length: number;
  width: number;
  grateType: string;
  openArea: number;
  splashVeloc: number;
}

/** Every field of an inlet design (`SWMM_InletDesign`). */
export interface InletDesign {
  type: number;
  grateLength: number;
  grateWidth: number;
  grateType: number;
  openArea: number;
  splashVeloc: number;
  curbLength: number;
  curbHeight: number;
  throat: number;
  slotLength: number;
  slotWidth: number;
  curveId: string;
  curveKind: number;
}

function designFields(values: Partial<InletDesign>): StructValue {
  if (values.curveId !== undefined) {
    const id = values.curveId ?? "";
    if (id.includes("\0")) throw new RangeError("curve_id must not contain NUL");
    if (new TextEncoder().encode(id).length >= 64) {
      throw new RangeError("curve_id is longer than 63 bytes");
    }
  }
  return snake(values);
}

/** `solver.infrastructure.inlets`: inlet designs. */
export class Inlets extends NamedFamily {
  protected readonly _kind = "inlet";

  /** Add an inlet design of type `inletType` (e.g. `"GRATE"`); returns its index. */
  add(inletId: string, inletType: string): number {
    raiseForCode(this._raw.swmm_inlet_add(this._h, inletId, inletType));
    this._solver._bumpGeneration();
    return this.length - 1;
  }

  setParams(
    idx: number,
    {
      length = 0,
      width = 0,
      grateType = "",
      openArea = 0,
      splashVeloc = 0,
    }: Partial<InletParams> = {},
  ): void {
    raiseForCode(
      this._raw.swmm_inlet_set_params(
        this._h,
        idx,
        length,
        width,
        grateType,
        openArea,
        splashVeloc,
      ),
    );
  }

  /** Grate/slotted dimensions (the type string comes from {@link getType}). */
  getParams(idx: number): InletParams {
    const mod = this._mod;
    const p = checkedAlloc(mod, 32 + 256);
    try {
      mod.HEAPU8.fill(0, p, p + 32 + 256);
      raiseForCode(
        this._raw.swmm_inlet_get_params(this._h, idx, p, p + 8, p + 32, 256, p + 16, p + 24),
      );
      const f = mod.HEAPF64;
      return {
        length: f[p >> 3],
        width: f[(p + 8) >> 3],
        grateType: mod.UTF8ToString(p + 32, 256),
        openArea: f[(p + 16) >> 3],
        splashVeloc: f[(p + 24) >> 3],
      };
    } finally {
      mod._free(p);
    }
  }

  /** The type string given to {@link add}. */
  getType(idx: number): string {
    const mod = this._mod;
    const buf = checkedAlloc(mod, 256);
    try {
      mod.HEAPU8[buf] = 0;
      raiseForCode(this._raw.swmm_inlet_get_type(this._h, idx, buf, 256));
      return mod.UTF8ToString(buf, 256);
    } finally {
      mod._free(buf);
    }
  }

  /** Every field of a design; fields its type does not use read as zero. */
  getDesign(key: Key): InletDesign {
    const idx = typeof key === "string" ? this.getIndex(key) : key;
    return withStruct(this._mod, "SWMM_InletDesign", (p) => {
      raiseForCode(this._raw.swmm_inlet_get_design(this._h, idx, p));
      return camel<InletDesign>(readStruct(this._mod, "SWMM_InletDesign", p));
    });
  }

  /**
   * Overwrite a design (the type may change). Fields left out keep their
   * current values, so `setDesign("Curb1", { throat: ThroatType.INCLINED })`
   * is a read-modify-write.
   */
  setDesign(key: Key, design: Partial<InletDesign> = {}): void {
    const idx = typeof key === "string" ? this.getIndex(key) : key;
    const fields = designFields(design);
    const mod = this._mod;
    withStruct(mod, "SWMM_InletDesign", (p) => {
      raiseForCode(this._raw.swmm_inlet_get_design(this._h, idx, p));
      const strings: number[] = [];
      try {
        writeStruct(mod, "SWMM_InletDesign", p, fields, strings);
        raiseForCode(this._raw.swmm_inlet_set_design(this._h, idx, p));
      } finally {
        for (const s of strings) mod._free(s);
      }
    });
  }

  /**
   * The normalized design, changing no inlet: inactive fields cleared and a
   * custom curve's kind derived from the named curve when it exists.
   */
  validateDesign(design: Partial<InletDesign>): InletDesign {
    return withStructs(this._mod, "SWMM_InletDesign", [designFields(design)], (proposed) =>
      withStruct(this._mod, "SWMM_InletDesign", (normalized) => {
        raiseForCode(this._raw.swmm_inlet_validate_design(this._h, proposed, normalized));
        return camel<InletDesign>(readStruct(this._mod, "SWMM_InletDesign", normalized));
      }),
    );
  }

  getComment(key: Key): string {
    const idx = typeof key === "string" ? this.getIndex(key) : key;
    return withCString(this._mod, 256, (buf, len) =>
      this._raw.swmm_inlet_get_comment(this._h, idx, buf, len),
    );
  }

  setComment(key: Key, text: string): void {
    const idx = typeof key === "string" ? this.getIndex(key) : key;
    raiseForCode(this._raw.swmm_inlet_set_comment(this._h, idx, text ?? ""));
  }
}

// ---- inlet placements -------------------------------------------------------------

/** One inlet placement row (`SWMM_InletUsage`); flows and lengths in display units. */
export interface InletUsageRecord {
  hostKind: InletHostKind;
  hostIdx: number;
  designIdx: number;
  captureNodeIdx: number;
  numInlets: number;
  pctClogged: number;
  flowLimit: number;
  localDepress: number;
  localWidth: number;
  placement: InletPlacement;
}

/**
 * `solver.infrastructure.inletUsages`: inlet placements on conduits
 * (`[INLET_USAGE]`) and inlet junctions (`[INLET_JUNCTIONS]`), one store.
 */
export class InletUsages extends SolverView {
  get length(): number {
    return Math.max(this._raw.swmm_inlet_usage_count(this._h), 0);
  }

  /** Row hosted by conduit `linkIdx`, or -1. */
  findLink(linkIdx: number): number {
    return this._raw.swmm_inlet_usage_find_link(this._h, Math.trunc(linkIdx));
  }

  /** Row hosted by inlet junction `nodeIdx`, or -1. */
  findNode(nodeIdx: number): number {
    return this._raw.swmm_inlet_usage_find_node(this._h, Math.trunc(nodeIdx));
  }

  get(usageIdx: number): InletUsageRecord {
    return withStruct(this._mod, "SWMM_InletUsage", (p) => {
      raiseForCode(this._raw.swmm_inlet_usage_get(this._h, usageIdx, p));
      return camel<InletUsageRecord>(readStruct(this._mod, "SWMM_InletUsage", p));
    });
  }

  /** Preflight a placement without changing rows. */
  validate(record: InletUsageRecord): void {
    withStructs(this._mod, "SWMM_InletUsage", [snake(record)], (p) =>
      raiseForCode(this._raw.swmm_inlet_usage_validate(this._h, p)),
    );
  }

  /**
   * Create or replace the row of a host (one row per host). A NODE host must
   * already be an inlet junction; a LINK host must be a conduit. Returns the
   * row index.
   */
  set(
    hostKind: InletHostKind | number,
    hostIdx: number,
    designIdx: number,
    captureNodeIdx: number,
    {
      numInlets = 1,
      pctClogged = 0,
      flowLimit = 0,
      localDepress = 0,
      localWidth = 0,
      placement = InletPlacement.AUTOMATIC,
    }: Partial<
      Pick<
        InletUsageRecord,
        "numInlets" | "pctClogged" | "flowLimit" | "localDepress" | "localWidth" | "placement"
      >
    > = {},
  ): number {
    const record = {
      hostKind,
      hostIdx,
      designIdx,
      captureNodeIdx,
      numInlets,
      pctClogged,
      flowLimit,
      localDepress,
      localWidth,
      placement,
    };
    const row = withStructs(this._mod, "SWMM_InletUsage", [snake(record)], (p) =>
      withInt(this._mod, (out) => {
        this._mod.HEAP32[out >> 2] = -1;
        return this._raw.swmm_inlet_usage_set(this._h, p, out);
      }),
    );
    this._solver._bumpGeneration();
    return row;
  }

  remove(usageIdx: number): void {
    raiseForCode(this._raw.swmm_inlet_usage_remove(this._h, usageIdx));
    this._solver._bumpGeneration();
  }

  *[Symbol.iterator](): Iterator<InletUsageRecord> {
    const n = this.length;
    for (let i = 0; i < n; i++) yield this.get(i);
  }
}

// ---- LID controls ------------------------------------------------------------------

/** Richards flow options of a LID node stack. */
export interface LidFlowOptions {
  /** 0 the existing formulation, 1 Richards. */
  model: number;
  cellsPerLayer: number;
  atol: number;
  rtol: number;
  /** Seconds. */
  maxStep: number;
}

/** Retention material of one authored layer; `alpha`, `specificStorage` in 1/m. */
export interface LidMaterial {
  thetaR: number;
  alpha: number;
  n: number;
  l: number;
  specificStorage: number;
}

/** Storage-node LID assignment (`*Ft` values are exact internal feet). */
export interface StorageLidState {
  control: number;
  saturation: number;
  bottom: number;
  maxDepthFt: number;
}

/** A link anchored to a LID node layer. */
export interface StorageLidAnchor {
  link: number;
  layer: number;
  top: number;
  offsetUpFt: number;
  offsetDownFt: number;
  crestFt: number;
}

/** A node's LID assignment and anchors (Python `node_snapshot`). */
export interface LidNodeSnapshot {
  state: StorageLidState;
  anchors: StorageLidAnchor[];
}

/** A complete `[LID_USAGE]` placement (project input units). */
export interface LidUsageRecord {
  subcatchIndex: number;
  lidIndex: number;
  number: number;
  area: number;
  width: number;
  initSat: number;
  fromImperv: number;
  toPerv: number;
  fromPerv: number;
  reportFile?: string;
  reportFileResolved?: string;
  drainTo?: string;
}

/** The numeric fields of a placement (Python `usage_get`). */
export type LidUsage = Omit<LidUsageRecord, "reportFile" | "reportFileResolved" | "drainTo">;

const BOTTOM_MODES = ["CURRENT", "SEALED", "MESH_AQUIFER"] as const;

function usageFields(r: LidUsageRecord): StructValue {
  const text = (v: string | undefined) => {
    const s = v ?? "";
    if (s.includes("\0")) throw new RangeError("Record strings cannot contain null bytes");
    return s;
  };
  return {
    subcatch_idx: r.subcatchIndex,
    control_idx: r.lidIndex,
    number: r.number,
    area: r.area,
    width: r.width,
    init_sat: r.initSat,
    from_imperv: r.fromImperv,
    to_perv: r.toPerv,
    from_perv: r.fromPerv,
    report_file: text(r.reportFile),
    report_file_resolved: text(r.reportFileResolved),
    drain_to: text(r.drainTo),
  };
}

/**
 * `solver.infrastructure.lids`: `[LID_CONTROLS]` (layers, removals, node
 * stacks with Richards flow) and `[LID_USAGE]` placements.
 */
export class LIDs extends NamedFamily {
  protected readonly _kind = "lid";

  /** Add a LID control; returns its index. */
  add(lidId: string, lidType: LidType | number): number {
    raiseForCode(this._raw.swmm_lid_add(this._h, lidId, lidType));
    this._solver._bumpGeneration();
    return this.length - 1;
  }

  /** @internal */
  private _node(key: Key): number {
    const h = this._h;
    if (typeof key === "string") return resolveIndex(this._raw, h, "node", key);
    const n = this._raw.swmm_node_count(h);
    if (!Number.isInteger(key) || key < 0 || key >= n) {
      throw new RangeError(`Node index ${key} out of range [0, ${n})`);
    }
    return key;
  }

  /** @internal */
  private _link(key: Key): number {
    const h = this._h;
    if (typeof key === "string") return resolveIndex(this._raw, h, "link", key);
    const n = this._raw.swmm_link_count(h);
    if (!Number.isInteger(key) || key < 0 || key >= n) {
      throw new RangeError(`Link index ${key} out of range [0, ${n})`);
    }
    return key;
  }

  // ---- node layer stacks ---------------------------------------------------------

  /** The ordered stack, including an optional BOTTOM boundary. */
  getLayers(key: Key): LidNodeLayer[] {
    const idx = this._index(key);
    const n = this._raw.swmm_lid_node_layer_count(this._h, idx);
    return withStruct(this._mod, "SWMM_LidNodeLayer", (p) =>
      Array.from({ length: n }, (_, i) => {
        raiseForCode(this._raw.swmm_lid_node_layer_get(this._h, idx, i, p));
        const row = readStruct(this._mod, "SWMM_LidNodeLayer", p) as {
          kind: number;
          params: number[];
        };
        const kind = row.kind as LidNodeLayerKind;
        return new LidNodeLayer(kind, row.params.slice(0, [2, 7, 3, 2][kind]));
      }),
    );
  }

  getTreatments(key: Key): LidLayerTreatment[] {
    const idx = this._index(key);
    const h = this._h;
    const n = this._raw.swmm_lid_node_treatment_count(h, idx);
    return withStruct(this._mod, "SWMM_LidLayerTreatment", (p) =>
      Array.from({ length: n }, (_, i) => {
        raiseForCode(this._raw.swmm_lid_node_treatment_get(h, idx, i, p));
        const r = readStruct(this._mod, "SWMM_LidLayerTreatment", p) as {
          layer: number;
          pollutant: number;
          removal_percent: number;
          decay_per_day: number;
          expression: string;
        };
        return new LidLayerTreatment(
          r.layer,
          this._raw.swmm_pollutant_id(h, r.pollutant) ?? "",
          r.removal_percent,
          r.decay_per_day,
          r.expression,
        );
      }),
    );
  }

  /** Flow model (0 existing, 1 Richards), cells and solver tolerances. */
  getFlowOptions(key: Key): LidFlowOptions {
    const idx = this._index(key);
    return withStruct(this._mod, "SWMM_LidRichardsOptions", (p) => {
      raiseForCode(this._raw.swmm_lid_richards_options_get(this._h, idx, p));
      return camel<LidFlowOptions>(readStruct(this._mod, "SWMM_LidRichardsOptions", p));
    });
  }

  /** Retention materials in layer order (SURFACE/BOTTOM rows are ignored by flow). */
  getMaterials(key: Key): LidMaterial[] {
    const idx = this._index(key);
    const n = this._raw.swmm_lid_node_layer_count(this._h, idx);
    return withStruct(this._mod, "SWMM_LidRichardsMaterial", (p) =>
      Array.from({ length: n }, (_, i) => {
        raiseForCode(this._raw.swmm_lid_richards_material_get(this._h, idx, i, p));
        return camel<LidMaterial>(readStruct(this._mod, "SWMM_LidRichardsMaterial", p));
      }),
    );
  }

  /**
   * Replace a NODE stack atomically and sync its nodes (pre-start only). An
   * invalid stack leaves the old stack, node depths and anchored offsets
   * unchanged. With `flow`, omitted treatments/materials keep their current
   * values.
   */
  setLayers(
    key: Key,
    layers: Iterable<LidNodeLayer>,
    options: {
      treatments?: Iterable<LidLayerTreatment> | null;
      flow?: Partial<LidFlowOptions> & Pick<LidFlowOptions, "model">;
      materials?: Iterable<Partial<LidMaterial>> | null;
    } = {},
  ): void {
    this._configure(key, layers, options, false);
  }

  /** Preflight a complete NODE profile (flow and treatments included), changing nothing. */
  validateLayers(
    key: Key,
    layers: Iterable<LidNodeLayer>,
    options: {
      flow: Partial<LidFlowOptions> & Pick<LidFlowOptions, "model">;
      treatments?: Iterable<LidLayerTreatment> | null;
      materials?: Iterable<Partial<LidMaterial>> | null;
    },
  ): void {
    if (!options?.flow) throw new RangeError("flow options are required for profile validation");
    this._configure(key, layers, options, true);
  }

  /** @internal */
  private _configure(
    key: Key,
    layers: Iterable<LidNodeLayer>,
    {
      treatments,
      flow,
      materials,
    }: {
      treatments?: Iterable<LidLayerTreatment> | null;
      flow?: Partial<LidFlowOptions> & Pick<LidFlowOptions, "model">;
      materials?: Iterable<Partial<LidMaterial>> | null;
    },
    validate: boolean,
  ): void {
    const h = this._h;
    const idx = this._index(key);
    const rows = Array.from(layers);
    if (!rows.length) throw new RangeError("At least one MEDIA or AGGREGATE layer is required");
    if (rows.some((l) => !(l instanceof LidNodeLayer))) {
      throw new TypeError("layers must contain LidNodeLayer instances");
    }
    if (!flow && materials) throw new RangeError("materials requires flow options");
    let materialRows: StructValue[] = [];
    let rules = treatments ? Array.from(treatments) : null;
    if (flow) {
      const values = materials ? Array.from(materials) : this.getMaterials(key);
      if (values.length !== rows.length) {
        throw new RangeError("materials must have one row per authored layer");
      }
      materialRows = values.map((m) => ({
        theta_r: m.thetaR ?? 0,
        alpha: m.alpha ?? 0,
        n: m.n ?? 0,
        l: m.l ?? 0.5,
        specific_storage: m.specificStorage ?? 0,
      }));
      rules ??= this.getTreatments(key);
    }
    if (rules?.some((t) => !(t instanceof LidLayerTreatment))) {
      throw new TypeError("treatments must contain LidLayerTreatment instances");
    }
    const layerRows = rows.map((l) => ({ kind: l.kind, params: [...l.params] }));
    withStructs(this._mod, "SWMM_LidNodeLayer", layerRows, (lp) => {
      if (!rules) {
        raiseForCode(this._raw.swmm_lid_node_layers_set(h, idx, lp, rows.length));
        return;
      }
      const ruleRows = rules.map((t) => ({
        layer: t.layer,
        pollutant: resolveIndex(this._raw, h, "pollutant", t.pollutant),
        removal_percent: t.removalPercent,
        decay_per_day: t.decayPerDay,
        expression: t.expression,
      }));
      withStructs(this._mod, "SWMM_LidLayerTreatment", ruleRows, (tp) => {
        const tptr = ruleRows.length ? tp : 0;
        if (!flow) {
          raiseForCode(
            this._raw.swmm_lid_node_configure(h, idx, lp, rows.length, tptr, ruleRows.length),
          );
          return;
        }
        const options = {
          model: flow.model,
          cells_per_layer: flow.cellsPerLayer ?? 8,
          atol: flow.atol ?? 1e-7,
          rtol: flow.rtol ?? 1e-5,
          max_step: flow.maxStep ?? 30,
        };
        withStructs(this._mod, "SWMM_LidRichardsOptions", [options], (op) =>
          withStructs(this._mod, "SWMM_LidRichardsMaterial", materialRows, (mp) => {
            const call = validate
              ? this._raw.swmm_lid_node_validate_flow
              : this._raw.swmm_lid_node_configure_flow;
            raiseForCode(call(h, idx, lp, rows.length, tptr, ruleRows.length, op, mp));
          }),
        );
      });
    });
  }

  // ---- storage-node assignments ----------------------------------------------------

  /** Assign a control to a storage node; syncs its MaxDepth (InitSat %). */
  assignNode(node: Key, control: Key, { initialSaturation = 0 } = {}): void {
    const n = this._node(node);
    const c = this._index(control);
    raiseForCode(this._raw.swmm_node_set_lid(this._h, n, c, initialSaturation));
  }

  /** `[control index, InitSat %]`, or `null` for an ordinary node. */
  nodeAssignment(node: Key): [number, number] | null {
    const n = this._node(node);
    const mod = this._mod;
    const p = checkedAlloc(mod, 16);
    try {
      mod.HEAP32[p >> 2] = -1;
      mod.HEAPF64[(p + 8) >> 3] = 0;
      raiseForCode(this._raw.swmm_node_get_lid(this._h, n, p, p + 8));
      const c = mod.HEAP32[p >> 2];
      return c < 0 ? null : [c, mod.HEAPF64[(p + 8) >> 3]];
    } finally {
      mod._free(p);
    }
  }

  /** Revert a LID storage node to plain storage and remove its anchors. */
  removeNode(node: Key): void {
    raiseForCode(this._raw.swmm_node_set_lid(this._h, this._node(node), -1, 0));
  }

  /** Runtime sublayers, top to bottom; elevations in model length units. */
  nodeProfile(node: Key): { layer: number; bottom: number; top: number; moisture: number }[] {
    const n = this._node(node);
    const count = this._raw.swmm_lid_node_state_count(this._h, n);
    const mod = this._mod;
    const p = checkedAlloc(mod, 32);
    try {
      return Array.from({ length: count }, (_, i) => {
        mod.HEAPU8.fill(0, p, p + 32);
        raiseForCode(this._raw.swmm_lid_node_state_get(this._h, n, i, p, p + 8, p + 16, p + 24));
        const f = mod.HEAPF64;
        return {
          layer: mod.HEAP32[p >> 2],
          bottom: f[(p + 8) >> 3],
          top: f[(p + 16) >> 3],
          moisture: f[(p + 24) >> 3],
        };
      });
    } finally {
      mod._free(p);
    }
  }

  /** Richards cells: pressure/head in project length, water in volume units. */
  richardsProfile(node: Key): { pressure: number; head: number; water: number }[] {
    const n = this._node(node);
    const count = this._raw.swmm_lid_node_state_count(this._h, n);
    return Array.from({ length: count }, (_, i) => {
      const [pressure, head, water] = doubles(this._mod, 3, ([a, b, c]) =>
        this._raw.swmm_lid_richards_state_get(this._h, n, i, a, b, c),
      );
      return { pressure, head, water };
    });
  }

  /** Last-interval counts, minimum step (s) and balance (m³). */
  richardsStatistics(node: Key): {
    accepted: number;
    rejected: number;
    rhs: number;
    newton: number;
    minStep: number;
    balanceM3: number;
  } {
    const n = this._node(node);
    return withStruct(this._mod, "SWMM_LidRichardsStatistics", (p) => {
      raiseForCode(this._raw.swmm_lid_richards_statistics_get(this._h, n, p));
      return camel(readStruct(this._mod, "SWMM_LidRichardsStatistics", p));
    });
  }

  /** Geometric LID contact area in project square-length units, before init. */
  nodeBaseArea(node: Key): number {
    const n = this._node(node);
    return withDouble(this._mod, (p) => this._raw.swmm_lid_node_base_area(this._h, n, p));
  }

  /**
   * Accepted mesh-bottom diagnostics, always SI (positive net is LID to
   * aquifer). Needs an initialized explicit mesh-bottom connection.
   */
  nodeBottomState(node: Key): Record<string, number> {
    const n = this._node(node);
    return withStruct(this._mod, "SWMM_LidBottomState", (p) => {
      raiseForCode(this._raw.swmm_lid_node_bottom_state_get(this._h, n, p));
      return camel<Record<string, number>>(readStruct(this._mod, "SWMM_LidBottomState", p));
    });
  }

  /** Per-node bottom owner. */
  nodeBottom(node: Key): (typeof BOTTOM_MODES)[number] {
    const n = this._node(node);
    return BOTTOM_MODES[
      withInt(this._mod, (p) => this._raw.swmm_node_get_lid_bottom(this._h, n, p))
    ];
  }

  /** Change one assigned LID's bottom owner without editing the shared control. */
  setNodeBottom(node: Key, mode: string): void {
    const n = this._node(node);
    const m = BOTTOM_MODES.indexOf(String(mode).toUpperCase() as (typeof BOTTOM_MODES)[number]);
    if (m < 0) throw new RangeError("bottom must be CURRENT, SEALED or MESH_AQUIFER");
    raiseForCode(this._raw.swmm_node_set_lid_bottom(this._h, n, m));
  }

  /** Anchor a link to a one-based physical layer; layer 0 removes the anchor. */
  setOutletAnchor(
    link: Key,
    layer: number,
    { position = "BOTTOM" }: { position?: string } = {},
  ): void {
    const i = this._link(link);
    const pos = position.toUpperCase();
    if (pos !== "TOP" && pos !== "BOTTOM") throw new RangeError("position must be TOP or BOTTOM");
    raiseForCode(this._raw.swmm_lid_node_outlet_set(this._h, i, layer, pos === "TOP" ? 1 : 0));
  }

  /** `[one-based layer, "TOP" | "BOTTOM"]`, or `null` if unanchored. */
  getOutletAnchor(link: Key): [number, "TOP" | "BOTTOM"] | null {
    const i = this._link(link);
    const mod = this._mod;
    const p = checkedAlloc(mod, 8);
    try {
      mod.HEAP32[p >> 2] = 0;
      mod.HEAP32[(p + 4) >> 2] = 0;
      raiseForCode(this._raw.swmm_lid_node_outlet_get(this._h, i, p, p + 4));
      const layer = mod.HEAP32[p >> 2];
      return layer === 0 ? null : [layer, mod.HEAP32[(p + 4) >> 2] ? "TOP" : "BOTTOM"];
    } finally {
      mod._free(p);
    }
  }

  /** The node's assignment and the anchors of its links. */
  nodeSnapshot(node: Key): LidNodeSnapshot {
    const h = this._h;
    const n = this._node(node);
    const mod = this._mod;
    const state = withStruct(mod, "SWMM_StorageLidState", (p) => {
      raiseForCode(this._raw.swmm_storage_lid_get(h, n, p));
      return camel<StorageLidState>(readStruct(mod, "SWMM_StorageLidState", p));
    });
    const anchors: StorageLidAnchor[] = [];
    withStruct(mod, "SWMM_StorageLidAnchor", (p) => {
      const ends = checkedAlloc(mod, 8);
      try {
        for (let link = 0; link < this._raw.swmm_link_count(h); link++) {
          raiseForCode(this._raw.swmm_link_get_from_node(h, link, ends));
          raiseForCode(this._raw.swmm_link_get_to_node(h, link, ends + 4));
          if (mod.HEAP32[ends >> 2] === n || mod.HEAP32[(ends + 4) >> 2] === n) {
            raiseForCode(this._raw.swmm_storage_lid_anchor_get(h, link, p));
            const a = camel<StorageLidAnchor>(readStruct(mod, "SWMM_StorageLidAnchor", p));
            if (a.layer > 0) anchors.push(a);
          }
        }
      } finally {
        mod._free(ends);
      }
    });
    return { state, anchors };
  }

  /** Prepare an assignment without changing anything (dependent geometry in internal feet). */
  prepareNode(
    node: Key,
    control: Key | null,
    { initialSaturation = 0, bottom = 0 }: { initialSaturation?: number; bottom?: number } = {},
  ): LidNodeSnapshot {
    const h = this._h;
    const n = this._node(node);
    const c = control === null ? -1 : this._index(control);
    const mod = this._mod;
    const capacity = this._raw.swmm_link_count(h);
    const anchorSize = STRUCTS.SWMM_StorageLidAnchor.size;
    return withStruct(mod, "SWMM_StorageLidState", (sp) =>
      withStructs(mod, "SWMM_StorageLidAnchor", Array<StructValue>(capacity).fill({}), (ap) => {
        const count = withInt(mod, (cp) =>
          this._raw.swmm_storage_lid_prepare(
            h,
            n,
            c,
            initialSaturation,
            bottom,
            sp,
            capacity ? ap : 0,
            capacity,
            cp,
          ),
        );
        return {
          state: camel<StorageLidState>(readStruct(mod, "SWMM_StorageLidState", sp)),
          anchors: Array.from({ length: count }, (_, i) =>
            camel<StorageLidAnchor>(readStruct(mod, "SWMM_StorageLidAnchor", ap + i * anchorSize)),
          ),
        };
      }),
    );
  }

  /** Validate a complete assignment snapshot without changing anything (before initialization). */
  validateNode(node: Key, snapshot: LidNodeSnapshot): void {
    this._install(node, snapshot, true);
  }

  /** Restore an assignment and its anchors atomically (exact internal-foot geometry). */
  replaceNode(node: Key, snapshot: LidNodeSnapshot): void {
    this._install(node, snapshot, false);
  }

  /** @internal */
  private _install(node: Key, snapshot: LidNodeSnapshot, validate: boolean): void {
    const h = this._h;
    const n = this._node(node);
    const anchors = snapshot.anchors.map((a) => snake(a));
    withStructs(this._mod, "SWMM_StorageLidState", [snake(snapshot.state)], (sp) =>
      withStructs(this._mod, "SWMM_StorageLidAnchor", anchors, (ap) => {
        const call = validate
          ? this._raw.swmm_storage_lid_validate
          : this._raw.swmm_storage_lid_replace;
        raiseForCode(call(h, n, sp, anchors.length ? ap : 0, anchors.length));
      }),
    );
  }

  // ---- control parameters ------------------------------------------------------------

  setSurface(
    idx: number,
    { storage, roughness, slope }: { storage: number; roughness: number; slope: number },
  ): void {
    raiseForCode(this._raw.swmm_lid_set_surface(this._h, idx, storage, roughness, slope));
  }

  getSurface(idx: number): { storage: number; roughness: number; slope: number } {
    const [storage, roughness, slope] = doubles(this._mod, 3, ([a, b, c]) =>
      this._raw.swmm_lid_get_surface(this._h, idx, a, b, c),
    );
    return { storage, roughness, slope };
  }

  setSoil(
    idx: number,
    p: { thick: number; porosity: number; fc: number; wp: number; ksat: number; kslope: number },
  ): void {
    raiseForCode(
      this._raw.swmm_lid_set_soil(this._h, idx, p.thick, p.porosity, p.fc, p.wp, p.ksat, p.kslope),
    );
  }

  getSoil(idx: number): {
    thick: number;
    porosity: number;
    fc: number;
    wp: number;
    ksat: number;
    kslope: number;
  } {
    const [thick, porosity, fc, wp, ksat, kslope] = doubles(this._mod, 6, ([a, b, c, d, e, f]) =>
      this._raw.swmm_lid_get_soil(this._h, idx, a, b, c, d, e, f),
    );
    return { thick, porosity, fc, wp, ksat, kslope };
  }

  setStorage(
    idx: number,
    { thick, voidFrac, ksat }: { thick: number; voidFrac: number; ksat: number },
  ): void {
    raiseForCode(this._raw.swmm_lid_set_storage(this._h, idx, thick, voidFrac, ksat));
  }

  getStorage(idx: number): { thick: number; voidFrac: number; ksat: number } {
    const [thick, voidFrac, ksat] = doubles(this._mod, 3, ([a, b, c]) =>
      this._raw.swmm_lid_get_storage(this._h, idx, a, b, c),
    );
    return { thick, voidFrac, ksat };
  }

  setDrain(
    idx: number,
    { coeff, expon, offset }: { coeff: number; expon: number; offset: number },
  ): void {
    raiseForCode(this._raw.swmm_lid_set_drain(this._h, idx, coeff, expon, offset));
  }

  getDrain(idx: number): { coeff: number; expon: number; offset: number } {
    const [coeff, expon, offset] = doubles(this._mod, 3, ([a, b, c]) =>
      this._raw.swmm_lid_get_drain(this._h, idx, a, b, c),
    );
    return { coeff, expon, offset };
  }

  /**
   * Set the pavement layer. Leave `regenDegree` out to keep the stored
   * fraction; a given degree must lie in [0, 1].
   */
  setPavement(
    idx: number,
    {
      thick,
      voidRatio,
      fracImperv,
      ksat,
      clogFactor = 0,
      regenDays = 0,
      regenDegree,
    }: {
      thick: number;
      voidRatio: number;
      fracImperv: number;
      ksat: number;
      clogFactor?: number;
      regenDays?: number;
      regenDegree?: number | null;
    },
  ): void {
    const h = this._h;
    if (regenDegree === undefined || regenDegree === null) {
      raiseForCode(
        this._raw.swmm_lid_set_pavement(
          h,
          idx,
          thick,
          voidRatio,
          fracImperv,
          ksat,
          clogFactor,
          regenDays,
        ),
      );
    } else {
      raiseForCode(
        this._raw.swmm_lid_set_pavement_ex(
          h,
          idx,
          thick,
          voidRatio,
          fracImperv,
          ksat,
          clogFactor,
          regenDays,
          regenDegree,
        ),
      );
    }
  }

  getPavement(idx: number): {
    thick: number;
    voidRatio: number;
    fracImperv: number;
    ksat: number;
    clogFactor: number;
    regenDays: number;
    regenDegree: number;
  } {
    const [thick, voidRatio, fracImperv, ksat, clogFactor, regenDays, regenDegree] = doubles(
      this._mod,
      7,
      ([a, b, c, d, e, f, g]) =>
        this._raw.swmm_lid_get_pavement_ex(this._h, idx, a, b, c, d, e, f, g),
    );
    return { thick, voidRatio, fracImperv, ksat, clogFactor, regenDays, regenDegree };
  }

  /** Set the drainage-mat layer (GREEN_ROOF). */
  setDrainmat(
    idx: number,
    { thick, voidFrac, roughness }: { thick: number; voidFrac: number; roughness: number },
  ): void {
    raiseForCode(this._raw.swmm_lid_set_drainmat(this._h, idx, thick, voidFrac, roughness));
  }

  getDrainmat(idx: number): { thick: number; voidFrac: number; roughness: number } {
    const [thick, voidFrac, roughness] = doubles(this._mod, 3, ([a, b, c]) =>
      this._raw.swmm_lid_get_drainmat(this._h, idx, a, b, c),
    );
    return { thick, voidFrac, roughness };
  }

  /**
   * Underdrain removal (percent) of a constituent: below the pollutant
   * count a pollutant, pollutant count + m reaction species m. No entry reads 0.
   */
  getRemoval(idx: number, constituent: number): number {
    return withDouble(this._mod, (p) =>
      this._raw.swmm_lid_get_removal(this._h, idx, constituent, p),
    );
  }

  /** Set the underdrain removal (0-100); 0 removes the entry. Before `start()` only. */
  setRemoval(idx: number, constituent: number, percent: number): void {
    raiseForCode(this._raw.swmm_lid_set_removal(this._h, idx, constituent, percent));
  }

  /** The control's {@link LidType} code. */
  getType(idx: number): number {
    return withInt(this._mod, (p) => {
      this._mod.HEAP32[p >> 2] = -1;
      return this._raw.swmm_lid_get_type(this._h, idx, p);
    });
  }

  /** Change the type of an unassigned control before a node stack is applied. */
  setType(idx: number, lidType: LidType | number): void {
    raiseForCode(this._raw.swmm_lid_set_type(this._h, idx, lidType));
  }

  /** Preflight a type change, changing nothing. */
  validateType(idx: number, lidType: LidType | number): void {
    raiseForCode(this._raw.swmm_lid_validate_type(this._h, idx, lidType));
  }

  /** One {@link LidExtraField} scalar, in authored input units. */
  getExtra(idx: number, field: number): number {
    return withDouble(this._mod, (p) => this._raw.swmm_lid_get_extra(this._h, idx, field, p));
  }

  /** Set one checked scalar, keeping its sibling fields. */
  setExtra(idx: number, field: number, value: number): void {
    raiseForCode(this._raw.swmm_lid_set_extra(this._h, idx, field, value));
  }

  /** The authored drain curve token. */
  getDrainCurve(idx: number): string {
    const h = this._h;
    if (!(idx >= 0 && idx < this._raw.swmm_lid_count(h))) throw new RangeError(String(idx));
    return this._raw.swmm_lid_get_drain_curve(h, idx) ?? "";
  }

  // ---- [LID_USAGE] placements ----------------------------------------------------------

  /** Place control `lid` (an index, as in Python) on a subcatchment. */
  usageAdd(
    subcatchment: Key,
    lid: number,
    {
      number,
      area,
      width,
      initSat = 0,
      fromImperv = 0,
    }: { number: number; area: number; width: number; initSat?: number; fromImperv?: number },
  ): void {
    if (typeof lid === "string") {
      throw new TypeError(
        "LID lookup by id is not supported by the C API; pass the integer index returned from add(id, type)",
      );
    }
    const si = this._subcatch(subcatchment);
    raiseForCode(
      this._raw.swmm_lid_usage_add(this._h, si, lid, number, area, width, initSat, fromImperv),
    );
  }

  /** @internal */
  private _subcatch(key: Key): number {
    const h = this._h;
    if (typeof key === "string") return resolveIndex(this._raw, h, "subcatch", key);
    const n = this._raw.swmm_subcatch_count(h);
    if (!Number.isInteger(key) || key < 0 || key >= n) {
      throw new RangeError(`Subcatchment index ${key} out of range [0, ${n})`);
    }
    return key;
  }

  /** Placement rows across all subcatchments. */
  usageCount(): number {
    return this._raw.swmm_lid_usage_count(this._h);
  }

  /** One placement's numeric fields. */
  usageGet(usageIdx: number): LidUsage {
    const mod = this._mod;
    const p = checkedAlloc(mod, 80);
    try {
      mod.HEAPU8.fill(0, p, p + 80);
      raiseForCode(
        this._raw.swmm_lid_usage_get(
          this._h,
          usageIdx,
          p,
          p + 4,
          p + 8,
          p + 16,
          p + 24,
          p + 32,
          p + 40,
          p + 48,
          p + 56,
        ),
      );
      const f = mod.HEAPF64;
      const i = mod.HEAP32;
      return {
        subcatchIndex: i[p >> 2],
        lidIndex: i[(p + 4) >> 2],
        number: i[(p + 8) >> 2],
        area: f[(p + 16) >> 3],
        width: f[(p + 24) >> 3],
        initSat: f[(p + 32) >> 3],
        fromImperv: f[(p + 40) >> 3],
        toPerv: i[(p + 48) >> 2],
        fromPerv: f[(p + 56) >> 3],
      };
    } finally {
      mod._free(p);
    }
  }

  /** Remove one placement by global index. */
  usageRemove(usageIdx: number): void {
    raiseForCode(this._raw.swmm_lid_usage_remove(this._h, usageIdx));
    this._solver._bumpGeneration();
  }

  /** A complete placement, report paths and drain target included. */
  usageRecord(usageIdx: number): LidUsageRecord {
    return withStruct(this._mod, "SWMM_LidUsageRecord", (p) => {
      raiseForCode(this._raw.swmm_lid_usage_get_record(this._h, usageIdx, p));
      const r = readStruct(this._mod, "SWMM_LidUsageRecord", p) as Record<string, number | string>;
      return {
        subcatchIndex: r.subcatch_idx as number,
        lidIndex: r.control_idx as number,
        number: r.number as number,
        area: r.area as number,
        width: r.width as number,
        initSat: r.init_sat as number,
        fromImperv: r.from_imperv as number,
        toPerv: r.to_perv as number,
        fromPerv: r.from_perv as number,
        reportFile: r.report_file as string,
        reportFileResolved: r.report_file_resolved as string,
        drainTo: r.drain_to as string,
      };
    });
  }

  /** Preflight a complete placement, changing nothing (project input units). */
  validateUsage(record: LidUsageRecord): void {
    withStructs(this._mod, "SWMM_LidUsageRecord", [usageFields(record)], (p) =>
      raiseForCode(this._raw.swmm_lid_usage_validate_record(this._h, p)),
    );
  }

  /** Replace one subcatchment's ordered placements atomically; other rows stay. */
  replaceUsages(subcatchment: Key, records: Iterable<LidUsageRecord>): void {
    const n = this._subcatch(subcatchment);
    const rows = Array.from(records, usageFields);
    withStructs(this._mod, "SWMM_LidUsageRecord", rows, (p) =>
      raiseForCode(
        this._raw.swmm_lid_usage_replace_subcatch(this._h, n, rows.length ? p : 0, rows.length),
      ),
    );
    this._solver._bumpGeneration();
  }
}

/** `solver.infrastructure`: the five infrastructure views. */
export class Infrastructure {
  readonly transects: Transects;
  readonly streets: Streets;
  readonly inlets: Inlets;
  readonly inletUsages: InletUsages;
  readonly lids: LIDs;

  /** @internal */
  constructor(solver: Solver) {
    this.transects = new Transects(solver);
    this.streets = new Streets(solver);
    this.inlets = new Inlets(solver);
    this.inletUsages = new InletUsages(solver);
    this.lids = new LIDs(solver);
  }
}
