/**
 * @file Tables.ts
 * @brief Time series, curves and patterns (Python `openswmm.engine._tables`).
 *
 * The engine keeps time series and curves in one table namespace:
 * {@link Tables} (`solver.tables`) indexes both and hands back
 * {@link TimeSeries} or {@link Curve} views. {@link Patterns}
 * (`solver.patterns`) holds the `[PATTERNS]` entries.
 *
 * Tables are created in the BUILDING or OPENED state (after `open()`, before
 * `initialize()`). Table indices never shift (tables are not removed), so a view
 * stays valid across adds, renames and type changes; removing a pattern
 * shifts the later patterns and invalidates pattern views. Closing or
 * reopening the solver invalidates every view.
 *
 * @license  Apache-2.0
 */

import { PatternType, TableType } from "./enums.js";
import { ElementNotFoundError, LifecycleError, StaleObjectError, raiseForCode } from "./errors.js";
import { datetimeToOadate, oadateToDatetime } from "./dates.js";
import { checkedAlloc, guardedRaw, withDouble, withDoubleInput, withInt } from "./mem.js";
import type { RawApi } from "./raw.js";
import type { Solver } from "./Solver.js";
import type { OpenSwmmWasmModule } from "./types.js";

/** One point of a table: `[x, y]`. */
export type TablePoint = [number, number];

/** Rows for {@link PointTable.replacePoints} / {@link PointTable.validatePoints}. */
export interface PointRows {
  /** Leading rows authored relative to `anchor` (time series only). */
  relativeCount?: number;
  /** OADate days the relative rows count from. */
  anchor?: number;
}

/** Rethrow a creation LifecycleError with the states that allow creation. */
function creationLifecycle(op: string, err: unknown): never {
  if (err instanceof LifecycleError) {
    throw new LifecycleError(
      `${op} requires the engine in BUILDING or OPENED state: add tables, curves and ` +
        `patterns after open() and before initialize()/start()`,
    );
  }
  throw err;
}

/** Shared owner state of the table and pattern collections. */
interface Owner {
  readonly mod: OpenSwmmWasmModule;
  readonly raw: RawApi;
  readonly engine: number;
  readonly generation: number;
}

// =============================================================================
// PointTable / TimeSeries / Curve
// =============================================================================

/**
 * A table of `(x, y)` points: the common part of {@link TimeSeries} and
 * {@link Curve} (Python `_PointTable`). {@link Tables.get} returns this
 * generic view; {@link Tables.asTimeseries} and {@link Tables.asCurve} the
 * typed ones.
 */
export class PointTable<P = TablePoint> {
  /** @internal */
  protected readonly _owner: Tables;
  /** @internal */
  private readonly _generation: number;
  /** @internal */
  private readonly _capturedId: string;

  /** Zero-based index in {@link Tables}. */
  readonly index: number;

  /** @internal */
  constructor(owner: Tables, index: number) {
    this._owner = owner;
    this._generation = owner.generation;
    this.index = index;
    this._capturedId = owner.raw.swmm_table_id(owner.engine, index) ?? "";
  }

  /** @internal */
  protected get _o(): Owner {
    if (this._generation !== this._owner.generation) throw new StaleObjectError();
    return this._owner;
  }

  /** The solver that owns this table. */
  get solver(): Solver {
    return this._owner.solver;
  }

  /** Table identifier. */
  get id(): string {
    const o = this._o;
    return o.raw.swmm_table_id(o.engine, this.index) ?? "";
  }

  /** Number of points. */
  get length(): number {
    const o = this._o;
    return withInt(o.mod, (p) => o.raw.swmm_table_get_point_count(o.engine, this.index, p));
  }

  /** Append an `(x, y)` point. */
  addPoint(x: number, y: number): void {
    const o = this._o;
    raiseForCode(o.raw.swmm_table_add_point(o.engine, this.index, x, y));
  }

  /** Remove every point. */
  clear(): void {
    const o = this._o;
    raiseForCode(o.raw.swmm_table_clear(o.engine, this.index));
  }

  /**
   * Check raw `[x, y]` rows without changing the table. For a time series x
   * and `anchor` are OADate days.
   */
  validatePoints(points: Iterable<TablePoint>, options: PointRows = {}): void {
    this._rows(points, options, (x, y, n, relative, anchor) => {
      const o = this._o;
      return o.raw.swmm_table_validate_points(o.engine, this.index, x, y, n, relative, anchor);
    });
  }

  /**
   * Replace every point and the relative-row metadata at once.
   *
   * @param options.fileToken `undefined` keeps the table's FILE reference, `""`
   *   detaches it, any other value sets it.
   * @throws StaleObjectError when the index now names a different table.
   */
  replacePoints(
    points: Iterable<TablePoint>,
    options: PointRows & { fileToken?: string } = {},
  ): void {
    if (this.id !== this._capturedId) {
      throw new StaleObjectError("Table changed; reacquire it before replacing points");
    }
    this._rows(points, options, (x, y, n, relative, anchor) => {
      const o = this._o;
      return o.raw.swmm_table_replace_points(
        o.engine,
        this.index,
        x,
        y,
        n,
        relative,
        anchor,
        options.fileToken ?? null,
      );
    });
  }

  /** Interpolate y at `x` with the engine's table lookup. */
  lookup(x: number): number {
    const o = this._o;
    return withDouble(o.mod, (p) => o.raw.swmm_table_lookup(o.engine, this.index, x, p));
  }

  /** Raw `[x, y]` points; {@link TimeSeries} and {@link Curve} give typed rows. */
  get points(): P[] {
    return this._rawPoints() as unknown as P[];
  }

  /** @internal */
  protected _rawPoints(): TablePoint[] {
    const o = this._o;
    const n = this.length;
    const p = checkedAlloc(o.mod, 16);
    try {
      const out: TablePoint[] = [];
      for (let i = 0; i < n; i++) {
        raiseForCode(o.raw.swmm_table_get_point(o.engine, this.index, i, p, p + 8));
        out.push([o.mod.HEAPF64[p >> 3], o.mod.HEAPF64[(p >> 3) + 1]]);
      }
      return out;
    } finally {
      o.mod._free(p);
    }
  }

  /** @internal Copy rows into x and y arrays and call `fn(x*, y*, n, relative, anchor)`. */
  private _rows(
    points: Iterable<TablePoint>,
    { relativeCount = 0, anchor = 0 }: PointRows,
    fn: (x: number, y: number, n: number, relative: number, anchor: number) => number,
  ): void {
    const rows = Array.from(points);
    if (rows.some((r) => r.length !== 2)) throw new RangeError("points must contain [x, y] rows");
    const o = this._o;
    const n = rows.length;
    const x = checkedAlloc(o.mod, 16 * Math.max(n, 1));
    try {
      rows.forEach(([xi, yi], i) => {
        o.mod.HEAPF64[(x >> 3) + i] = xi;
        o.mod.HEAPF64[(x >> 3) + n + i] = yi;
      });
      raiseForCode(fn(x, x + 8 * n, n, relativeCount, anchor));
    } finally {
      o.mod._free(x);
    }
  }
}

/** A SWMM time series: x is a SWMM DateTime, read back as a `Date` (UTC). */
export class TimeSeries extends PointTable<[Date, number]> {
  /** `[leading relative rows, OADate anchor]`; stored x values stay absolute. */
  get relativeInfo(): [number, number] {
    const o = this._o;
    const p = checkedAlloc(o.mod, 16);
    try {
      raiseForCode(o.raw.swmm_timeseries_get_relative_info(o.engine, this.index, p, p + 8));
      return [o.mod.HEAP32[p >> 2], o.mod.HEAPF64[(p + 8) >> 3]];
    } finally {
      o.mod._free(p);
    }
  }

  /** Mark the leading `count` rows as relative to `anchor` (0 = all dated). */
  setRelativeInfo(count: number, anchor: number): void {
    const o = this._o;
    raiseForCode(o.raw.swmm_timeseries_set_relative_info(o.engine, this.index, count, anchor));
  }

  /** `[time, value]` rows; times are whole seconds, as Python's `datetime64[s]`. */
  override get points(): [Date, number][] {
    return this._rawPoints().map(([x, y]) => {
      const t = oadateToDatetime(x);
      t.setUTCMilliseconds(0);
      return [t, y];
    });
  }

  /** Append a point at `when` (a `Date`, UTC, or a SWMM DateTime). */
  add(when: Date | number, value: number): void {
    this.addPoint(when instanceof Date ? datetimeToOadate(when) : when, value);
  }
}

/** A SWMM curve: x and y are plain numbers. */
export class Curve extends PointTable<TablePoint> {}

// =============================================================================
// Tables
// =============================================================================

/**
 * `solver.tables`: every time series and curve, by index or id. The view type
 * returned by {@link get} is generic; use {@link asTimeseries} /
 * {@link asCurve} for the typed ones.
 */
export class Tables implements Owner {
  /** @internal */
  readonly mod: OpenSwmmWasmModule;
  /** @internal */
  readonly raw: RawApi;
  /** @internal */
  readonly engine: number;
  /** @internal Bumped by the solver on open/close; older views turn stale. */
  generation = 0;
  /** @internal */
  readonly solver: Solver;

  /** @internal */
  constructor(mod: OpenSwmmWasmModule, engine: number, solver: Solver, checkOwner: () => void) {
    this.mod = mod;
    this.raw = guardedRaw(mod, checkOwner);
    this.engine = engine;
    this.solver = solver;
  }

  /** Number of tables (time series and curves). */
  get length(): number {
    return this.raw.swmm_table_count(this.engine);
  }

  /** @internal */
  private _resolve(key: number | string): number {
    if (typeof key === "string") return this.getIndex(key);
    const n = this.length;
    const idx = key < 0 ? key + n : key;
    if (!Number.isInteger(idx) || idx < 0 || idx >= n) {
      throw new ElementNotFoundError(key, `Table index ${key} out of range [0, ${n})`);
    }
    return idx;
  }

  /** The table at an index (negative counts from the end) or id. */
  get(key: number | string): PointTable {
    return new PointTable(this, this._resolve(key));
  }

  /** True when a table with this index or id exists. */
  has(key: number | string): boolean {
    try {
      this._resolve(key);
      return true;
    } catch (err) {
      if (err instanceof ElementNotFoundError) return false;
      throw err;
    }
  }

  [Symbol.iterator](): Iterator<PointTable> {
    const n = this.length;
    let i = 0;
    return {
      next: (): IteratorResult<PointTable> =>
        i < n ? { value: this.get(i++), done: false } : { value: undefined, done: true },
    };
  }

  /** Zero-based index of a table id. @throws ElementNotFoundError */
  getIndex(tableId: string): number {
    const i = this.raw.swmm_table_index(this.engine, tableId);
    if (i < 0) throw new ElementNotFoundError(tableId);
    return i;
  }

  /** Id of the table at `idx`. @throws ElementNotFoundError */
  getId(idx: number): string {
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.length)
      throw new ElementNotFoundError(idx);
    return this.raw.swmm_table_id(this.engine, idx) ?? "";
  }

  /** The {@link TableType} of a table. */
  getType(key: number | string): TableType {
    const i = this._resolve(key);
    return withInt(this.mod, (p) => this.raw.swmm_table_get_type(this.engine, i, p)) as TableType;
  }

  /** Rename a table before initialization; references follow the new id. */
  rename(key: number | string, newId: string): void {
    if (newId.includes("\0")) throw new RangeError("newId must not contain NUL");
    raiseForCode(this.raw.swmm_table_rename(this.engine, this._resolve(key), newId));
  }

  /**
   * Change a curve's {@link TableType}, keeping its points and references.
   * Converting to or from TIMESERIES is refused.
   */
  setType(key: number | string, kind: TableType): void {
    raiseForCode(this.raw.swmm_table_set_type(this.engine, this._resolve(key), kind));
  }

  /** Add an empty time series and return its view. */
  addTimeseries(tsId: string): TimeSeries {
    try {
      raiseForCode(this.raw.swmm_timeseries_add(this.engine, tsId));
    } catch (err) {
      creationLifecycle("addTimeseries", err);
    }
    return new TimeSeries(this, this.getIndex(tsId));
  }

  /** Add an empty curve (`curveType`: legacy CurveType code, 0 = default). */
  addCurve(curveId: string, curveType = 0): Curve {
    try {
      raiseForCode(this.raw.swmm_curve_add(this.engine, curveId, curveType));
    } catch (err) {
      creationLifecycle("addCurve", err);
    }
    return new Curve(this, this.getIndex(curveId));
  }

  /** A {@link TimeSeries} view of a table. */
  asTimeseries(key: number | string): TimeSeries {
    return new TimeSeries(this, this._resolve(key));
  }

  /** A {@link Curve} view of a table. */
  asCurve(key: number | string): Curve {
    return new Curve(this, this._resolve(key));
  }
}

// =============================================================================
// Patterns
// =============================================================================

/** One `[PATTERNS]` entry. */
export class Pattern {
  /** @internal */
  private readonly _owner: Patterns;
  /** @internal */
  private readonly _generation: number;

  /** Zero-based index in {@link Patterns}. */
  readonly index: number;

  /** @internal */
  constructor(owner: Patterns, index: number) {
    this._owner = owner;
    this._generation = owner.generation;
    this.index = index;
  }

  /** @internal */
  private get _o(): Patterns {
    if (this._generation !== this._owner.generation) throw new StaleObjectError();
    return this._owner;
  }

  /** The solver that owns this pattern. */
  get solver(): Solver {
    return this._owner.solver;
  }

  /** Pattern identifier. */
  get id(): string {
    const o = this._o;
    return o.raw.swmm_pattern_id(o.engine, this.index) ?? "";
  }

  /** {@link PatternType}: MONTHLY, DAILY, HOURLY or WEEKEND. */
  get type(): PatternType {
    const o = this._o;
    return withInt(o.mod, (p) =>
      o.raw.swmm_pattern_get_type(o.engine, this.index, p),
    ) as PatternType;
  }

  /** Multipliers: 12 (monthly), 7 (daily) or 24 (hourly, weekend). */
  get factors(): number[] {
    const o = this._o;
    const n = withInt(o.mod, (p) => o.raw.swmm_pattern_get_factor_count(o.engine, this.index, p));
    return Array.from({ length: n }, (_, i) =>
      withDouble(o.mod, (p) => o.raw.swmm_pattern_get_factor(o.engine, this.index, i, p)),
    );
  }

  /**
   * Replace the multipliers. The type is fixed when the pattern is created;
   * `type` is accepted for parity with Python and ignored.
   */
  setFactors(values: ArrayLike<number>, type: PatternType = PatternType.HOURLY): void {
    void type;
    const o = this._o;
    withDoubleInput(o.mod, values, (p, n) =>
      o.raw.swmm_pattern_set_factors(o.engine, this.index, p, n),
    );
  }
}

/** `solver.patterns`: the `[PATTERNS]` entries, by index or id. */
export class Patterns {
  /** @internal */
  readonly mod: OpenSwmmWasmModule;
  /** @internal */
  readonly raw: RawApi;
  /** @internal */
  readonly engine: number;
  /** @internal Bumped on open/close and when a pattern is removed. */
  generation = 0;
  /** @internal */
  readonly solver: Solver;

  /** @internal */
  constructor(mod: OpenSwmmWasmModule, engine: number, solver: Solver, checkOwner: () => void) {
    this.mod = mod;
    this.raw = guardedRaw(mod, checkOwner);
    this.engine = engine;
    this.solver = solver;
  }

  /** Number of patterns. */
  get length(): number {
    return this.raw.swmm_pattern_count(this.engine);
  }

  /** @internal */
  private _resolve(key: number | string): number {
    if (typeof key === "string") return this.getIndex(key);
    const n = this.length;
    const idx = key < 0 ? key + n : key;
    if (!Number.isInteger(idx) || idx < 0 || idx >= n) {
      throw new ElementNotFoundError(key, `Pattern index ${key} out of range [0, ${n})`);
    }
    return idx;
  }

  /** The pattern at an index (negative counts from the end) or id. */
  get(key: number | string): Pattern {
    return new Pattern(this, this._resolve(key));
  }

  /** True when a pattern with this index or id exists. */
  has(key: number | string): boolean {
    try {
      this._resolve(key);
      return true;
    } catch (err) {
      if (err instanceof ElementNotFoundError) return false;
      throw err;
    }
  }

  [Symbol.iterator](): Iterator<Pattern> {
    const n = this.length;
    let i = 0;
    return {
      next: (): IteratorResult<Pattern> =>
        i < n ? { value: this.get(i++), done: false } : { value: undefined, done: true },
    };
  }

  /** Zero-based index of a pattern id. @throws ElementNotFoundError */
  getIndex(patternId: string): number {
    const i = this.raw.swmm_pattern_index(this.engine, patternId);
    if (i < 0) throw new ElementNotFoundError(patternId);
    return i;
  }

  /** Append a pattern (BUILDING or OPENED state) and return its view. */
  add(patternId: string, type: PatternType = PatternType.HOURLY): Pattern {
    try {
      raiseForCode(this.raw.swmm_pattern_add(this.engine, patternId, type));
    } catch (err) {
      creationLifecycle("patterns.add", err);
    }
    return new Pattern(this, this.length - 1);
  }

  /** Remove a pattern, clearing references to it. Invalidates pattern views. */
  remove(key: number | string): void {
    raiseForCode(this.raw.swmm_pattern_remove(this.engine, this._resolve(key)));
    this.generation++;
  }

  /** Rename a pattern; stored references follow the new id. */
  rename(key: number | string, newId: string): void {
    raiseForCode(this.raw.swmm_pattern_rename(this.engine, this._resolve(key), newId));
  }
}
