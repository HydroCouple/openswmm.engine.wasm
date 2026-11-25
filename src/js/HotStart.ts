/**
 * @file HotStart.ts
 * @brief Hot start files and the save schedule (Python
 *        `openswmm.engine._hotstart`).
 *
 * A {@link HotStart} is an open hot start file (native or legacy): read its
 * records, edit initial states (written back on {@link HotStart.close}), or
 * apply it to a solver. It owns a native handle: close it (or use `using`).
 * {@link SaveSchedule} is the model's `[SAVE HOTSTART]` list
 * (`solver.saveSchedule`). Record values are in internal units (ft, ft³, s).
 *
 * @license  Apache-2.0
 */

import { ErrorCode } from "./enums.js";
import { BadParamError, ElementNotFoundError, StaleObjectError, raiseForCode } from "./errors.js";
import { datetimeToOadate, oadateToDatetime } from "./dates.js";
import { checkedAlloc, rawOf, withCString, withDouble, withInt } from "./mem.js";
import type { RawApi } from "./raw.js";
import type { Solver } from "./Solver.js";
import type { OpenSwmmWasmModule } from "./types.js";
import { SolverView } from "./view.js";

const CONTENTS: [number, string][] = [
  [0x01, "SPECIES"],
  [0x02, "GROUNDWATER"],
  [0x04, "GW_TRANSPORT"],
  [0x08, "SNOW"],
  [0x10, "LID"],
  [0x20, "SURFACE"],
  [0x40, "ENGINE_CHECKPOINT"],
  [0x80, "LEGACY"],
];
const SAVE_FORMATS = ["AUTO", "LEGACY", "NATIVE"] as const;
const LEGACY_OMITS: [number, string][] = [
  [0x1, "WATER_AGE"],
  [0x2, "REACTION_SPECIES"],
  [0x4, "AQUIFER"],
  [0x8, "NODE_LIDS"],
];

/** A node record: depth/head (ft), volume (ft³), age (s; negative when untracked). */
export interface HotStartNodeRecord {
  id: string;
  depth: number;
  head: number;
  volume: number;
  age: number;
  concentrations: number[];
}

/** A link record: flow (ft³/s, signed), depth (ft), volume (ft³), age (s). */
export interface HotStartLinkRecord {
  id: string;
  flow: number;
  depth: number;
  volume: number;
  age: number;
  concentrations: number[];
}

/** A subcatchment record: runoff and groundwater flow (ft³/s), moisture, lower depth (ft). */
export interface HotStartSubcatchmentRecord {
  id: string;
  runoff: number;
  gwFlow: number;
  gwUpperMoisture: number;
  gwLowerDepth: number;
}

/** One `[SAVE HOTSTART]` entry. */
export interface SaveScheduleEntry {
  when: Date;
  path: string;
}

/** Raise a hot-start I/O error with the engine's detail. */
function checkIo(raw: RawApi, rc: number): void {
  if (rc === ErrorCode.HOTSTART) {
    const detail = raw.swmm_hotstart_last_io_error();
    if (detail) raiseForCode(rc, detail);
  }
  raiseForCode(rc);
}

const closeHandle = new FinalizationRegistry<{ raw: RawApi; handle: number }>(
  ({ raw, handle }) => void raw.swmm_hotstart_close(handle),
);

/** An open hot start file. */
export class HotStart {
  /** @internal */
  private _handle = 0;
  /** @internal */
  private readonly _mod: OpenSwmmWasmModule;
  /** @internal */
  private readonly _raw: RawApi;

  /** @internal Use {@link HotStart.open} or {@link HotStart.openLegacy}. */
  constructor(mod: OpenSwmmWasmModule, handle = 0) {
    this._mod = mod;
    this._raw = rawOf(mod);
    this._handle = handle;
    if (handle) closeHandle.register(this, { raw: this._raw, handle }, this);
  }

  /** Save the solver's current state to a new hot start file. */
  static saveFrom(solver: Solver, path: string): void {
    checkIo(rawOf(solver.module), rawOf(solver.module).swmm_hotstart_save(solver.handle, path));
  }

  /** Open a hot start file (in the module's virtual filesystem). */
  static open(mod: OpenSwmmWasmModule, path: string): HotStart {
    const raw = rawOf(mod);
    const out = checkedAlloc(mod, 4);
    try {
      mod.HEAPU32[out >> 2] = 0;
      checkIo(raw, raw.swmm_hotstart_open(path, out));
      return new HotStart(mod, mod.HEAPU32[out >> 2]);
    } finally {
      mod._free(out);
    }
  }

  /**
   * Open a legacy (SWMM 5) hot start file against `model` (OPENED or later):
   * its counts must match the model, whose names the records take. Read-only.
   */
  static openLegacy(model: Solver, path: string): HotStart {
    const mod = model.module;
    const raw = rawOf(mod);
    const out = checkedAlloc(mod, 4);
    try {
      mod.HEAPU32[out >> 2] = 0;
      checkIo(raw, raw.swmm_hotstart_open_legacy(model.handle, path, out));
      return new HotStart(mod, mod.HEAPU32[out >> 2]);
    } finally {
      mod._free(out);
    }
  }

  /** Write pending edits and release the handle (idempotent). */
  close(): void {
    if (this._handle) {
      closeHandle.unregister(this);
      this._raw.swmm_hotstart_close(this._handle);
      this._handle = 0;
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }

  /** @internal */
  private get _h(): number {
    if (!this._handle) throw new StaleObjectError("HotStart is closed");
    return this._handle;
  }

  /** Apply the file's state to a solver. */
  apply(solver: Solver): void {
    raiseForCode(this._raw.swmm_hotstart_apply(solver.handle, this._h));
  }

  /** Simulation start date of the run that saved the file. */
  get startDatetime(): Date {
    return oadateToDatetime(
      withDouble(this._mod, (p) => this._raw.swmm_hotstart_get_start_date(this._h, p)),
    );
  }

  /** Simulated time the file holds: the start date plus the elapsed time. */
  get simDatetime(): Date {
    const elapsed = withDouble(this._mod, (p) => this._raw.swmm_hotstart_get_sim_time(this._h, p));
    return new Date(this.startDatetime.getTime() + elapsed * 1000);
  }

  /** End date of the saving run, or `null`. */
  get endDatetime(): Date | null {
    const v = withDouble(this._mod, (p) => this._raw.swmm_hotstart_get_end_date(this._h, p));
    return v ? oadateToDatetime(v) : null;
  }

  /** When the file was written (UTC), or `null`. */
  get savedAt(): Date | null {
    const p = checkedAlloc(this._mod, 8);
    try {
      raiseForCode(this._raw.swmm_hotstart_get_saved_at(this._h, p));
      const seconds = this._mod.HEAPU32[p >> 2] + this._mod.HEAP32[(p >> 2) + 1] * 2 ** 32;
      return seconds ? new Date(seconds * 1000) : null;
    } finally {
      this._mod._free(p);
    }
  }

  /** Coordinate reference system, or `null` when the file has none. */
  get crs(): string | null {
    try {
      return (
        withCString(this._mod, 256, (buf, len) =>
          this._raw.swmm_hotstart_get_crs(this._h, buf, len),
        ) || null
      );
    } catch (err) {
      if (err instanceof StaleObjectError) throw err;
      return null;
    }
  }

  /** File format version. */
  get version(): number {
    return withInt(this._mod, (p) => this._raw.swmm_hotstart_get_version(this._h, p));
  }

  /** Sections the file holds (`"SPECIES"`, `"GROUNDWATER"`, ..., `"LEGACY"`). */
  get contents(): string[] {
    const flags = withInt(this._mod, (p) => this._raw.swmm_hotstart_get_contents(this._h, p));
    return CONTENTS.filter(([bit]) => flags & bit).map(([, name]) => name);
  }

  /** Number of node records. */
  get nodeCount(): number {
    return this._raw.swmm_hotstart_node_count(this._h);
  }
  /** Number of link records. */
  get linkCount(): number {
    return this._raw.swmm_hotstart_link_count(this._h);
  }
  /** Number of subcatchment records. */
  get subcatchmentCount(): number {
    return this._raw.swmm_hotstart_subcatch_count(this._h);
  }

  /** Names of the species whose concentrations the records hold. */
  get species(): string[] {
    const h = this._h;
    return Array.from({ length: this._raw.swmm_hotstart_species_count(h) }, (_, i) =>
      withCString(this._mod, 256, (buf, len) =>
        this._raw.swmm_hotstart_get_species(h, i, buf, len),
      ),
    );
  }

  /** Warnings raised while reading the file. */
  get warnings(): string[] {
    const h = this._h;
    return Array.from(
      { length: this._raw.swmm_hotstart_warning_count(h) },
      (_, i) => this._raw.swmm_hotstart_warning(h, i) ?? "",
    );
  }

  /** @internal Read `count` records with `get(i, idBuf, len, out0..out3)` and species. */
  private _records(
    count: number,
    get: (
      i: number,
      buf: number,
      len: number,
      a: number,
      b: number,
      c: number,
      d: number,
    ) => number,
    species?: (i: number, k: number, out: number) => number,
  ): [string, number[], number[]][] {
    const h = this._h;
    const ns = species ? this._raw.swmm_hotstart_species_count(h) : 0;
    const p = checkedAlloc(this._mod, 40);
    try {
      return Array.from({ length: count }, (_, i) => {
        const id = withCString(this._mod, 256, (buf, len) =>
          get(i, buf, len, p, p + 8, p + 16, p + 24),
        );
        const values = Array.from(this._mod.HEAPF64.subarray(p >> 3, (p >> 3) + 4));
        const conc = Array.from({ length: ns }, (_, k) => {
          raiseForCode(species!(i, k, p + 32));
          return this._mod.HEAPF64[(p + 32) >> 3];
        });
        return [id, values, conc];
      });
    } finally {
      this._mod._free(p);
    }
  }

  /** Every node record. */
  nodeRecords(): HotStartNodeRecord[] {
    const h = this._h;
    return this._records(
      this.nodeCount,
      (i, buf, len, a, b, c, d) => this._raw.swmm_hotstart_get_node(h, i, buf, len, a, b, c, d),
      (i, k, out) => this._raw.swmm_hotstart_get_node_species(h, i, k, out),
    ).map(([id, [depth, head, volume, age], concentrations]) => ({
      id,
      depth,
      head,
      volume,
      age,
      concentrations,
    }));
  }

  /** Every link record. */
  linkRecords(): HotStartLinkRecord[] {
    const h = this._h;
    return this._records(
      this.linkCount,
      (i, buf, len, a, b, c, d) => this._raw.swmm_hotstart_get_link(h, i, buf, len, a, b, c, d),
      (i, k, out) => this._raw.swmm_hotstart_get_link_species(h, i, k, out),
    ).map(([id, [flow, depth, volume, age], concentrations]) => ({
      id,
      flow,
      depth,
      volume,
      age,
      concentrations,
    }));
  }

  /** Every subcatchment record. */
  subcatchmentRecords(): HotStartSubcatchmentRecord[] {
    const h = this._h;
    return this._records(this.subcatchmentCount, (i, buf, len, a, b, c, d) =>
      this._raw.swmm_hotstart_get_subcatch(h, i, buf, len, a, b, c, d),
    ).map(([id, [runoff, gwFlow, gwUpperMoisture, gwLowerDepth]]) => ({
      id,
      runoff,
      gwFlow,
      gwUpperMoisture,
      gwLowerDepth,
    }));
  }

  /** Set a node's depth (ft). */
  setNodeDepth(nodeId: string, depth: number): void {
    raiseForCode(this._raw.swmm_hotstart_set_node_depth(this._h, nodeId, depth));
  }
  /** Set a node's head (ft). */
  setNodeHead(nodeId: string, head: number): void {
    raiseForCode(this._raw.swmm_hotstart_set_node_head(this._h, nodeId, head));
  }
  /** Set a link's flow (ft³/s). */
  setLinkFlow(linkId: string, flow: number): void {
    raiseForCode(this._raw.swmm_hotstart_set_link_flow(this._h, linkId, flow));
  }
  /** Set a link's depth (ft). */
  setLinkDepth(linkId: string, depth: number): void {
    raiseForCode(this._raw.swmm_hotstart_set_link_depth(this._h, linkId, depth));
  }
  /** Set a subcatchment's runoff (ft³/s). */
  setSubcatchmentRunoff(subId: string, runoff: number): void {
    raiseForCode(this._raw.swmm_hotstart_set_subcatch_runoff(this._h, subId, runoff));
  }
  /** Set a node's initial depth; head and volume are derived at restart. Written on close. */
  setNodeState(nodeId: string, depth: number): void {
    raiseForCode(this._raw.swmm_hotstart_set_node_state(this._h, nodeId, depth));
  }
  /** Set a link's initial flow and depth; volume is derived at restart. Written on close. */
  setLinkState(linkId: string, flow: number, depth: number): void {
    raiseForCode(this._raw.swmm_hotstart_set_link_state(this._h, linkId, flow, depth));
  }
}

type EntryInput = SaveScheduleEntry | [Date, string];

function unpack(value: EntryInput): [Date, string] {
  const [when, path] = Array.isArray(value) ? value : [value.when, value.path];
  if (!(when instanceof Date) || typeof path !== "string") {
    throw new TypeError("a save entry is {when, path} or [when, path]");
  }
  return [when, path];
}

/** `solver.saveSchedule`: the `[SAVE HOTSTART]` entries. */
export class SaveSchedule extends SolverView implements Iterable<SaveScheduleEntry> {
  /** Number of entries. */
  get length(): number {
    return withInt(this._mod, (p) => this._raw.swmm_hotstart_saves_count(this._h, p));
  }

  /** @internal */
  private _index(idx: number): number {
    const n = this.length;
    const i = idx < 0 ? idx + n : idx;
    if (!Number.isInteger(i) || i < 0 || i >= n) throw new ElementNotFoundError(idx);
    return i;
  }

  /** The entry at `idx` (negative counts from the end). */
  get(idx: number): SaveScheduleEntry {
    const i = this._index(idx);
    const path = withCString(this._mod, 256, (buf, len) =>
      this._raw.swmm_hotstart_saves_get_path(this._h, i, buf, len),
    );
    const when = withDouble(this._mod, (p) =>
      this._raw.swmm_hotstart_saves_get_datetime(this._h, i, p),
    );
    return { when: oadateToDatetime(when), path };
  }

  /** Replace the entry at `idx`. */
  set(idx: number, value: EntryInput): void {
    const i = this._index(idx);
    const [when, path] = unpack(value);
    raiseForCode(this._raw.swmm_hotstart_saves_set_path(this._h, i, path));
    raiseForCode(this._raw.swmm_hotstart_saves_set_datetime(this._h, i, datetimeToOadate(when)));
  }

  /** Remove the entry at `idx`. */
  delete(idx: number): void {
    raiseForCode(this._raw.swmm_hotstart_saves_remove(this._h, this._index(idx)));
  }

  /** Insert an entry at `idx` (the list is rebuilt; formats are kept). */
  insert(idx: number, value: EntryInput): void {
    const n = this.length;
    const rows: [EntryInput, string][] = Array.from({ length: n }, (_, i) => [
      this.get(i),
      this.getFormat(i),
    ]);
    rows.splice(Math.max(0, Math.min(idx < 0 ? idx + n : idx, n)), 0, [value, "AUTO"]);
    this.clear();
    rows.forEach(([entry, format], i) => {
      this.append(entry);
      if (format !== "AUTO") this.setFormat(i, format);
    });
  }

  /** Append an entry. */
  append(value: EntryInput): void {
    const [when, path] = unpack(value);
    raiseForCode(this._raw.swmm_hotstart_saves_add(this._h, path, datetimeToOadate(when)));
  }

  /** Remove every entry. */
  clear(): void {
    raiseForCode(this._raw.swmm_hotstart_saves_clear(this._h));
  }

  /** File format of an entry: `"AUTO"`, `"LEGACY"` or `"NATIVE"`. */
  getFormat(idx: number): string {
    const i = this._index(idx);
    return SAVE_FORMATS[
      withInt(this._mod, (p) => this._raw.swmm_hotstart_saves_get_format(this._h, i, p))
    ];
  }

  /** Set an entry's file format. */
  setFormat(idx: number, format: string): void {
    const code = SAVE_FORMATS.indexOf(
      String(format).toUpperCase() as (typeof SAVE_FORMATS)[number],
    );
    if (code < 0) {
      throw new BadParamError(
        `hot-start save format must be one of ${SAVE_FORMATS.join(", ")}; got ${format}`,
      );
    }
    raiseForCode(this._raw.swmm_hotstart_saves_set_format(this._h, this._index(idx), code));
  }

  /** What a legacy-format save would leave out for this model. */
  legacyOmits(): string[] {
    const flags = withInt(this._mod, (p) => this._raw.swmm_hotstart_legacy_omits(this._h, p));
    return LEGACY_OMITS.filter(([bit]) => flags & bit).map(([, name]) => name);
  }

  [Symbol.iterator](): Iterator<SaveScheduleEntry> {
    return Array.from({ length: this.length }, (_, i) => this.get(i))[Symbol.iterator]();
  }
}

// =============================================================================
// Restart records in GeoPackage and HDF5 files (Python `solver.restart`,
// `probe_restart_file`, `inspect_restart_file`)
// =============================================================================

/** What a restart file holds, judged from its first bytes. */
export type RestartFileKind = "NONE" | "HOTSTART" | "GEOPACKAGE" | "HDF5" | "OTHER";

const RESTART_BACKENDS: RestartFileKind[] = ["NONE", "HOTSTART", "GEOPACKAGE", "HDF5", "OTHER"];

/** Raise a restart file error with the engine's reason. */
function checkRestart(raw: RawApi, rc: number): void {
  if (rc !== 0) raiseForCode(rc, raw.swmm_restart_last_error() || undefined);
}

/**
 * What `path` (in the module's virtual filesystem) holds, judged from its
 * first bytes, without changing it: `"NONE"` (missing or empty), `"HOTSTART"`,
 * `"GEOPACKAGE"`, `"HDF5"` or `"OTHER"`.
 */
export function probeRestartFile(mod: OpenSwmmWasmModule, path: string): RestartFileKind {
  const raw = rawOf(mod);
  return RESTART_BACKENDS[withInt(mod, (p) => raw.swmm_restart_probe(path, p))];
}

/**
 * Runs and restart records of a GeoPackage or HDF5 file, read-only: the decoded
 * JSON of `swmm_restart_inspect_json` (`path`, `backend` and `runs`; each run has
 * `run_id`, provenance fields and `records`; each record has `record_id`,
 * `model_datetime` in decimal days, `elapsed_seconds`, `continuation`, `status`
 * and more). Only records whose `status` is `"complete"` can be restored. Throws
 * with the engine's reason for a missing file or one that is not a GeoPackage
 * or HDF5 file.
 */
export function inspectRestartFile(mod: OpenSwmmWasmModule, path: string): Record<string, unknown> {
  const raw = rawOf(mod);
  const need = checkedAlloc(mod, 4);
  try {
    mod.HEAPU32[need >> 2] = 0;
    checkRestart(raw, raw.swmm_restart_inspect_json(path, 0, 0, need));
    const size = mod.HEAPU32[need >> 2];
    const buf = checkedAlloc(mod, Math.max(1, size));
    try {
      checkRestart(raw, raw.swmm_restart_inspect_json(path, buf, size, need));
      return JSON.parse(mod.UTF8ToString(buf, size)) as Record<string, unknown>;
    } finally {
      mod._free(buf);
    }
  } finally {
    mod._free(need);
  }
}

/**
 * `solver.restart`: the model's `[RESTART]` section, the saved state the run
 * starts from and where it records its own. Whether the settings agree is
 * checked when the run initializes.
 *
 * ```ts
 * const r = solver.restart;
 * r.sourceFile = "/previous.gpkg";
 * r.sourceRecord = "LATEST";
 * r.mode = "INITIAL_CONDITIONS"; // or "CONTINUE"
 * r.recordFile = "/states.h5";
 * r.recordFormat = "HDF5"; // or "GEOPACKAGE"
 * r.recordAt = ["END", new Date(Date.UTC(2020, 0, 1, 0, 30))];
 * r.recordEvery = 900; // seconds; 0 for none
 * ```
 */
export class RestartSettings extends SolverView {
  /** @internal */
  private _get(key: string): string {
    return withCString(this._mod, 256, (buf, len) =>
      this._raw.swmm_restart_get(this._h, key, buf, len),
    );
  }

  /** @internal */
  private _set(key: string, value: string): void {
    raiseForCode(this._raw.swmm_restart_set(this._h, key, value));
  }

  /** Restart file to start from; empty turns restoring off. */
  get sourceFile(): string {
    return this._get("SOURCE_FILE");
  }
  set sourceFile(value: string) {
    this._set("SOURCE_FILE", value);
  }

  /** Run in the source file; empty selects its only run. */
  get sourceRun(): string {
    return this._get("SOURCE_RUN");
  }
  set sourceRun(value: string) {
    this._set("SOURCE_RUN", value);
  }

  /** Record ID, or `"LATEST"`. */
  get sourceRecord(): string {
    return this._get("SOURCE_RECORD");
  }
  set sourceRecord(value: string) {
    this._set("SOURCE_RECORD", value);
  }

  /** `"INITIAL_CONDITIONS"` or `"CONTINUE"`. */
  get mode(): string {
    return this._get("MODE");
  }
  set mode(value: string) {
    this._set("MODE", value);
  }

  /** File this run records its states into; empty turns recording off. */
  get recordFile(): string {
    return this._get("RECORD_FILE");
  }
  set recordFile(value: string) {
    this._set("RECORD_FILE", value);
  }

  /** `"GEOPACKAGE"`, `"HDF5"` or empty; never inferred. */
  get recordFormat(): string {
    return this._get("RECORD_FORMAT");
  }
  set recordFormat(value: string) {
    this._set("RECORD_FORMAT", value);
  }

  /** Interval between records in seconds; 0 for none. */
  get recordEvery(): number {
    return Number(this._get("RECORD_EVERY"));
  }
  set recordEvery(seconds: number) {
    this._set("RECORD_EVERY", String(Number(seconds)));
  }

  /** Records carry the engine checkpoint so they can CONTINUE. */
  get recordContinuation(): boolean {
    return this._get("RECORD_CONTINUATION") === "YES";
  }
  set recordContinuation(value: boolean) {
    this._set("RECORD_CONTINUATION", value ? "YES" : "NO");
  }

  /**
   * True when the initialized run restores or records an engine checkpoint.
   * Such a run that saves binary results needs a new output file.
   */
  get usesCheckpoint(): boolean {
    return withInt(this._mod, (p) => this._raw.swmm_restart_uses_checkpoint(this._h, p)) !== 0;
  }

  /** Requested record times: `"END"` or a `Date` (UTC wall clock) each. */
  get recordAt(): ("END" | Date)[] {
    const n = withInt(this._mod, (p) => this._raw.swmm_restart_record_at_count(this._h, p));
    return Array.from({ length: n }, (_, i) => {
      const when = withDouble(this._mod, (p) =>
        this._raw.swmm_restart_record_at_get(this._h, i, p),
      );
      return when === 0 ? "END" : oadateToDatetime(when);
    });
  }
  set recordAt(values: ("END" | Date)[]) {
    raiseForCode(this._raw.swmm_restart_record_at_clear(this._h));
    for (const v of values) {
      const when =
        typeof v === "string" && v.toUpperCase() === "END" ? 0 : datetimeToOadate(v as Date);
      raiseForCode(this._raw.swmm_restart_record_at_add(this._h, when));
    }
  }
}
