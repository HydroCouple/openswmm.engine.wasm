/**
 * @file OutputReader.ts
 * @brief `OutputReader`: read a SWMM binary `.out` file independently of a
 *        solver (Python `openswmm.engine._output_reader`).
 *
 * Results are float32 as stored in the file. Objects are selected by index or
 * id; time series take an inclusive period range.
 *
 * @license  Apache-2.0
 */

import {
  ErrorCode,
  FlowUnits,
  OutLinkVar,
  OutNodeVar,
  OutSubcatchVar,
  OutSystemVar,
} from "./enums.js";
import { oadateToDatetime } from "./dates.js";
import { ElementNotFoundError, FileError, StaleObjectError, raiseForCode } from "./errors.js";
import { checkedAlloc, rawOf, withDouble } from "./mem.js";
import type { RawApi } from "./raw.js";
import type { OpenSwmmWasmModule } from "./types.js";

const MS_PER_DAY = 86_400_000;
const OA_EPOCH_MS = Date.UTC(1899, 11, 30);

/** A SWMM DateTime as a `Date`, truncated to the whole second like Python. */
function periodDate(value: number): Date {
  const day = Math.floor(value);
  const us = Math.round((value - day) * MS_PER_DAY * 1000);
  return new Date(OA_EPOCH_MS + day * MS_PER_DAY + Math.floor(us / 1e6) * 1000);
}

type Kind = "node" | "link" | "subcatchment";

/** Flooding statistics of one node, re-derived from the file's report samples. */
export class OutputNodeStats {
  /** @internal */
  constructor(
    private readonly _reader: OutputReader,
    private readonly _index: number,
  ) {}

  /** @internal */
  private _get(fn: (h: number, idx: number, out: number) => number): number {
    const r = this._reader;
    return withDouble(r.module, (p) => fn(r._handleOrThrow(), this._index, p));
  }

  get maxDepth(): number {
    return this._get(this._reader._raw.swmm_output_get_node_stat_max_depth);
  }

  get maxOverflow(): number {
    return this._get(this._reader._raw.swmm_output_get_node_stat_max_overflow);
  }

  get volFlooded(): number {
    return this._get(this._reader._raw.swmm_output_get_node_stat_vol_flooded);
  }

  /** Cumulative flooded duration in seconds. */
  get timeFlooded(): number {
    return this._get(this._reader._raw.swmm_output_get_node_stat_time_flooded);
  }
}

/** Read a SWMM binary `.out` file. */
export class OutputReader {
  /** @internal */
  readonly _raw: RawApi;
  private _handle: number;
  private _ids: Partial<Record<Kind | "pollutant", string[]>> = {};
  private _periodTimes: Date[] | null = null;

  /**
   * Open an output file. With `live`, read a file still being written and
   * call {@link refresh} for new periods.
   *
   * @throws {@link FileError} if the file cannot be opened.
   */
  constructor(
    readonly module: OpenSwmmWasmModule,
    path: string,
    { live = false }: { live?: boolean } = {},
  ) {
    this._raw = rawOf(module);
    this._handle = live ? this._raw.swmm_output_open_live(path) : this._raw.swmm_output_open(path);
    if (!this._handle) {
      throw new FileError(ErrorCode.OUTFILE, `cannot open output file: ${path}`);
    }
  }

  /** @internal */
  _handleOrThrow(): number {
    if (!this._handle) throw new StaleObjectError("OutputReader is closed");
    return this._handle;
  }

  /** @internal */
  private get _h(): number {
    return this._handleOrThrow();
  }

  /** Close the file and release its handle. */
  close(): void {
    if (this._handle) {
      this._raw.swmm_output_close(this._handle);
      this._handle = 0;
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }

  /** Whether the file holds a core or optional subcatchment variable. */
  hasSubcatchVariable(code: number): boolean {
    return this._raw.swmm_output_has_subcatch_variable(this._h, code) !== 0;
  }

  /** Whether the reader is waiting for the writer's closing records. */
  get isLive(): boolean {
    return this._raw.swmm_output_is_live(this._h) !== 0;
  }

  /**
   * Pick up completed periods (and the closing records once written). Returns
   * the available period count. Does not modify the file.
   */
  refresh(): number {
    const mod = this.module;
    const p = checkedAlloc(mod, 4);
    try {
      mod.HEAP32[p >> 2] = 0;
      if (this._raw.swmm_output_refresh(this._h, p)) {
        throw new Error("Unable to refresh output file");
      }
      this._periodTimes = null;
      return mod.HEAP32[p >> 2];
    } finally {
      mod._free(p);
    }
  }

  // ---- metadata -------------------------------------------------------------

  get version(): number {
    return this._raw.swmm_output_get_version(this._h);
  }

  get flowUnits(): FlowUnits {
    return this._raw.swmm_output_get_flow_units(this._h) as FlowUnits;
  }

  get periodCount(): number {
    return this._raw.swmm_output_get_period_count(this._h);
  }

  /** Reporting time step in seconds (Python `timedelta`). */
  get reportStep(): number {
    return this._raw.swmm_output_get_report_step(this._h);
  }

  get startDatetime(): Date {
    return oadateToDatetime(
      withDouble(this.module, (p) => this._raw.swmm_output_get_start_date(this._h, p)),
    );
  }

  get pollutantCount(): number {
    return this._raw.swmm_output_get_pollut_count(this._h);
  }

  get nodeCount(): number {
    return this._raw.swmm_output_get_node_count(this._h);
  }

  get linkCount(): number {
    return this._raw.swmm_output_get_link_count(this._h);
  }

  get subcatchmentCount(): number {
    return this._raw.swmm_output_get_subcatch_count(this._h);
  }

  /** SWMM error code stored in the file footer (0 = clean run). */
  get errorCode(): number {
    return this._raw.swmm_output_get_error_code(this._h);
  }

  // ---- object ids -------------------------------------------------------------

  /** @internal */
  private _idList(kind: Kind | "pollutant"): string[] {
    const h = this._h;
    let ids = this._ids[kind];
    if (!ids) {
      const raw = this._raw;
      const [count, get] = {
        node: [raw.swmm_output_get_node_count, raw.swmm_output_get_node_id],
        link: [raw.swmm_output_get_link_count, raw.swmm_output_get_link_id],
        subcatchment: [raw.swmm_output_get_subcatch_count, raw.swmm_output_get_subcatch_id],
        pollutant: [raw.swmm_output_get_pollut_count, raw.swmm_output_get_pollut_id],
      }[kind] as [(h: number) => number, (h: number, i: number) => string];
      ids = Array.from({ length: count(h) }, (_, i) => get(h, i) ?? "");
      this._ids[kind] = ids;
    }
    return [...ids];
  }

  get nodeIds(): string[] {
    return this._idList("node");
  }

  get linkIds(): string[] {
    return this._idList("link");
  }

  get subcatchmentIds(): string[] {
    return this._idList("subcatchment");
  }

  /**
   * Species (pollutant) column names in column order. The water-age column
   * (`__WATER_AGE__`, in hours) reuses a concentration unit code, so key on
   * the name, not the unit code.
   */
  get pollutantIds(): string[] {
    return this._idList("pollutant");
  }

  /** Unit labels in species-column order, including reserved age/heat. */
  get pollutantUnits(): (string | null)[] {
    const h = this._h;
    const labels: Record<number, string> = { 0: "mg/L", 1: "ug/L", 2: "count/L" };
    const reserved: Record<string, string> = { __WATER_AGE__: "h", __TEMPERATURE__: "degC" };
    return this.pollutantIds.map(
      (name, i) => reserved[name] ?? labels[this._raw.swmm_output_get_pollut_units(h, i)] ?? null,
    );
  }

  // ---- time axis ----------------------------------------------------------------

  /** Every reporting period's time (whole seconds). Cached; a copy is returned. */
  get periodTimes(): Date[] {
    const h = this._h;
    if (!this._periodTimes) {
      const n = this._raw.swmm_output_get_period_count(h);
      this._periodTimes = Array.from({ length: n }, (_, i) =>
        periodDate(withDouble(this.module, (p) => this._raw.swmm_output_get_period_time(h, i, p))),
      );
    }
    return this._periodTimes.map((d) => new Date(d.getTime()));
  }

  // ---- index resolution ------------------------------------------------------------

  /** @internal */
  private _resolve(key: number | string, kind: Kind): number {
    if (typeof key === "string") {
      const idx = this._idList(kind).indexOf(key);
      if (idx < 0) throw new ElementNotFoundError(key);
      return idx;
    }
    if (typeof key !== "number" || !Number.isInteger(key)) {
      throw new TypeError(`${kind} key must be int or str, got ${typeof key}`);
    }
    const count = {
      node: this.nodeCount,
      link: this.linkCount,
      subcatchment: this.subcatchmentCount,
    }[kind];
    if (key < 0 || key >= count) {
      throw new RangeError(`${kind} index ${key} out of range [0, ${count})`);
    }
    return key;
  }

  /** @internal */
  private _floats(n: number, fill: (ptr: number) => number): Float32Array {
    const mod = this.module;
    const p = checkedAlloc(mod, Math.max(4 * n, 4));
    try {
      raiseForCode(fill(p));
      return new Float32Array(mod.HEAPU8.buffer, p, n).slice();
    } finally {
      mod._free(p);
    }
  }

  // ---- per-period results -------------------------------------------------------------

  /** Every node's value of `variable` at `period`. */
  nodeResult(period: number, variable: OutNodeVar | number): Float32Array {
    const h = this._h;
    return this._floats(this.nodeCount, (p) =>
      this._raw.swmm_output_get_node_result(h, period, variable, p),
    );
  }

  /** Every link's value of `variable` at `period`. */
  linkResult(period: number, variable: OutLinkVar | number): Float32Array {
    const h = this._h;
    return this._floats(this.linkCount, (p) =>
      this._raw.swmm_output_get_link_result(h, period, variable, p),
    );
  }

  /** Every subcatchment's value of `variable` at `period`. */
  subcatchmentResult(period: number, variable: OutSubcatchVar | number): Float32Array {
    const h = this._h;
    return this._floats(this.subcatchmentCount, (p) =>
      this._raw.swmm_output_get_subcatch_result(h, period, variable, p),
    );
  }

  /** The system-wide value of `variable` at `period`. */
  systemResult(period: number, variable: OutSystemVar | number): number {
    const h = this._h;
    return this._floats(1, (p) =>
      this._raw.swmm_output_get_system_result(h, period, variable, p),
    )[0];
  }

  // ---- time series -------------------------------------------------------------------

  /** @internal */
  private _range({ start, end }: SeriesRange): [number, number] {
    const n = this.periodCount;
    const s = start ?? 0;
    const e = end ?? n - 1;
    if (!(s >= 0 && s <= e && e <= n - 1)) {
      throw new RangeError(`period range [${s}, ${e}] out of [0, ${n - 1}]`);
    }
    return [s, e];
  }

  /** `variable` of one node over the reporting window (inclusive range). */
  nodeSeries(
    node: number | string,
    variable: OutNodeVar | number,
    range: SeriesRange = {},
  ): Float32Array {
    const idx = this._resolve(node, "node");
    const [s, e] = this._range(range);
    const h = this._h;
    return this._floats(e - s + 1, (p) =>
      this._raw.swmm_output_get_node_series(h, idx, variable, s, e, p),
    );
  }

  /** `variable` of one link over the reporting window (inclusive range). */
  linkSeries(
    link: number | string,
    variable: OutLinkVar | number,
    range: SeriesRange = {},
  ): Float32Array {
    const idx = this._resolve(link, "link");
    const [s, e] = this._range(range);
    const h = this._h;
    return this._floats(e - s + 1, (p) =>
      this._raw.swmm_output_get_link_series(h, idx, variable, s, e, p),
    );
  }

  /** `variable` of one subcatchment over the reporting window (inclusive range). */
  subcatchmentSeries(
    sub: number | string,
    variable: OutSubcatchVar | number,
    range: SeriesRange = {},
  ): Float32Array {
    const idx = this._resolve(sub, "subcatchment");
    const [s, e] = this._range(range);
    const h = this._h;
    return this._floats(e - s + 1, (p) =>
      this._raw.swmm_output_get_subcatch_series(h, idx, variable, s, e, p),
    );
  }

  /** A system-wide `variable` over the reporting window (inclusive range). */
  systemSeries(variable: OutSystemVar | number, range: SeriesRange = {}): Float32Array {
    const [s, e] = this._range(range);
    const h = this._h;
    return this._floats(e - s + 1, (p) =>
      this._raw.swmm_output_get_system_series(h, variable, s, e, p),
    );
  }

  // ---- all attributes at one period ------------------------------------------------------

  /** @internal */
  private _attributes(
    base: number,
    read: (values: number, count: number) => number,
  ): Map<number, number> {
    const mod = this.module;
    const budget = Math.max(32, base + this.pollutantCount);
    const p = checkedAlloc(mod, 4 * budget + 4);
    try {
      const count = p + 4 * budget;
      mod.HEAP32[count >> 2] = 0;
      raiseForCode(read(p, count));
      const n = mod.HEAP32[count >> 2];
      // Keyed by variable code; pollutant slots continue from POLLUT_BASE.
      const values = new Float32Array(mod.HEAPU8.buffer, p, n);
      return new Map(Array.from(values, (v, i) => [i, v]));
    } finally {
      mod._free(p);
    }
  }

  /** All output variables of a node at `period`, keyed by {@link OutNodeVar} code. */
  nodeAttributes(node: number | string, period: number): Map<number, number> {
    const idx = this._resolve(node, "node");
    const h = this._h;
    return this._attributes(OutNodeVar.POLLUT_BASE, (v, c) =>
      this._raw.swmm_output_get_node_attribute(h, idx, period, v, c),
    );
  }

  /** All output variables of a link at `period`, keyed by {@link OutLinkVar} code. */
  linkAttributes(link: number | string, period: number): Map<number, number> {
    const idx = this._resolve(link, "link");
    const h = this._h;
    return this._attributes(OutLinkVar.POLLUT_BASE, (v, c) =>
      this._raw.swmm_output_get_link_attribute(h, idx, period, v, c),
    );
  }

  /** All output variables of a subcatchment at `period`, keyed by {@link OutSubcatchVar} code. */
  subcatchmentAttributes(sub: number | string, period: number): Map<number, number> {
    const idx = this._resolve(sub, "subcatchment");
    const h = this._h;
    return this._attributes(OutSubcatchVar.POLLUT_BASE, (v, c) =>
      this._raw.swmm_output_get_subcatch_attribute(h, idx, period, v, c),
    );
  }

  // ---- node summary statistics --------------------------------------------------------------

  /**
   * Cumulative flooding statistics of a node, aggregated over the file's
   * report samples (the engine-side `Node.stats` are finer).
   */
  nodeStats(node: number | string): OutputNodeStats {
    return new OutputNodeStats(this, this._resolve(node, "node"));
  }
}

/** Inclusive period range of a series read; both ends default to the file's. */
export interface SeriesRange {
  start?: number | null;
  end?: number | null;
}
