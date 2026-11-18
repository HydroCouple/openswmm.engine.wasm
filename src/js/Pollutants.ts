/**
 * @file Pollutants.ts
 * @brief `solver.pollutants` (Python `openswmm.engine._pollutants`).
 *
 * @license  Apache-2.0
 */

import { ConcentrationUnits } from "./enums.js";
import { ElementNotFoundError, raiseForCode } from "./errors.js";
import { getDouble, getInt, resolveIndex, type ElementCtx } from "./element.js";
import { checkedAlloc } from "./mem.js";
import type { Solver } from "./Solver.js";
import { SolverView } from "./view.js";

/** One `[POLLUTANTS]` entry; stale after pollutants are added or renamed. */
export class Pollutant extends SolverView {
  /** @internal */
  constructor(
    solver: Solver,
    /** Zero-based index in {@link Pollutants}. */
    readonly index: number,
  ) {
    super(solver, true);
  }

  /** @internal */
  private _c(): ElementCtx {
    return { mod: this._mod, raw: this._raw, engine: this._h, index: this.index };
  }

  /** @internal */
  private _getD(fn: (e: number, i: number, out: number) => number): number {
    return getDouble(this._c(), fn);
  }

  /** Pollutant id. */
  get id(): string {
    return this._raw.swmm_pollutant_id(this._h, this.index) ?? "";
  }

  /** Concentration units ({@link ConcentrationUnits}). */
  get units(): ConcentrationUnits {
    const c = this._c();
    return getInt(c, c.raw.swmm_pollutant_get_units) as ConcentrationUnits;
  }
  set units(value: ConcentrationUnits) {
    raiseForCode(this._raw.swmm_pollutant_set_units(this._h, this.index, value));
  }

  /** First-order decay coefficient (1/days). */
  get kdecay(): number {
    return this._getD(this._raw.swmm_pollutant_get_kdecay);
  }
  set kdecay(value: number) {
    raiseForCode(this._raw.swmm_pollutant_set_kdecay(this._h, this.index, value));
  }

  /** Molecular weight. */
  get mwt(): number {
    return this._getD(this._raw.swmm_pollutant_get_mwt);
  }
  set mwt(value: number) {
    raiseForCode(this._raw.swmm_pollutant_set_mwt(this._h, this.index, value));
  }

  /** Concentration in rainfall. */
  get rainConc(): number {
    return this._getD(this._raw.swmm_pollutant_get_rain_conc);
  }
  set rainConc(value: number) {
    raiseForCode(this._raw.swmm_pollutant_set_rain_conc(this._h, this.index, value));
  }

  /** Concentration in groundwater. */
  get gwConc(): number {
    return this._getD(this._raw.swmm_pollutant_get_gw_conc);
  }
  set gwConc(value: number) {
    raiseForCode(this._raw.swmm_pollutant_set_gw_conc(this._h, this.index, value));
  }

  /** Initial concentration throughout the conveyance system. */
  get initConc(): number {
    return this._getD(this._raw.swmm_pollutant_get_init_conc);
  }
  set initConc(value: number) {
    raiseForCode(this._raw.swmm_pollutant_set_init_conc(this._h, this.index, value));
  }

  /** Concentration in RDII. */
  get rdiiConc(): number {
    return this._getD(this._raw.swmm_pollutant_get_rdii_conc);
  }
  set rdiiConc(value: number) {
    raiseForCode(this._raw.swmm_pollutant_set_rdii_conc(this._h, this.index, value));
  }

  /** Concentration in dry-weather flow. */
  get dwfConc(): number {
    return this._getD(this._raw.swmm_pollutant_get_dwf_conc);
  }
  set dwfConc(value: number) {
    raiseForCode(this._raw.swmm_pollutant_set_dwf_conc(this._h, this.index, value));
  }

  /** Whether buildup happens only during snowfall. */
  get snowOnly(): boolean {
    const c = this._c();
    return getInt(c, c.raw.swmm_pollutant_get_snow_only) !== 0;
  }
  set snowOnly(value: boolean) {
    raiseForCode(this._raw.swmm_pollutant_set_snow_only(this._h, this.index, value ? 1 : 0));
  }

  /** `[co-pollutant, fraction]`, or `null` when there is none. */
  get coPollutant(): [Pollutant, number] | null {
    const p = checkedAlloc(this._mod, 16);
    try {
      raiseForCode(this._raw.swmm_pollutant_get_co_pollutant(this._h, this.index, p, p + 8));
      const co = this._mod.HEAP32[p >> 2];
      return co < 0 ? null : [new Pollutant(this._solver, co), this._mod.HEAPF64[(p + 8) >> 3]];
    } finally {
      this._mod._free(p);
    }
  }

  /** Make this pollutant a fraction of another's runoff concentration. */
  setCoPollutant(co: Pollutant | number | string, fraction: number): void {
    const coIdx =
      co instanceof Pollutant ? co.index : resolveIndex(this._raw, this._h, "pollutant", co);
    raiseForCode(this._raw.swmm_pollutant_set_co_pollutant(this._h, this.index, coIdx, fraction));
  }
}

/** `solver.pollutants`: the `[POLLUTANTS]` entries by index or id. */
export class Pollutants extends SolverView implements Iterable<Pollutant> {
  /** Number of pollutants. */
  get length(): number {
    return this._raw.swmm_pollutant_count(this._h);
  }

  /** @internal */
  private _resolve(key: number | string): number {
    const i = resolveIndex(this._raw, this._h, "pollutant", key);
    if (i < 0 || i >= this.length) throw new ElementNotFoundError(key);
    return i;
  }

  /** The pollutant at an index or id. */
  get(key: number | string): Pollutant {
    return new Pollutant(this._solver, this._resolve(key));
  }

  /** True when a pollutant with this index or id exists. */
  has(key: number | string): boolean {
    try {
      this._resolve(key);
      return true;
    } catch (err) {
      if (err instanceof ElementNotFoundError) return false;
      throw err;
    }
  }

  [Symbol.iterator](): Iterator<Pollutant> {
    return Array.from({ length: this.length }, (_, i) => new Pollutant(this._solver, i))[
      Symbol.iterator
    ]();
  }

  /** Index of a pollutant id. @throws ElementNotFoundError */
  getIndex(pollutId: string): number {
    return this._resolve(pollutId);
  }

  /** Id at an index. @throws ElementNotFoundError */
  getId(idx: number): string {
    return this._raw.swmm_pollutant_id(this._h, this._resolve(idx));
  }

  /** Add a pollutant; earlier views become stale, as in Python. */
  add(pollutId: string, units: ConcentrationUnits = ConcentrationUnits.MG_PER_L): Pollutant {
    raiseForCode(this._raw.swmm_pollutant_add(this._h, pollutId, units));
    this._solver._bumpGeneration();
    return this.get(pollutId);
  }

  /** Rename a pollutant; references follow. Earlier views become stale. */
  rename(key: number | string, newId: string): void {
    raiseForCode(this._raw.swmm_pollutant_rename(this._h, this._resolve(key), newId));
    this._solver._bumpGeneration();
  }

  /** Set a node's concentration of a pollutant. */
  setNodeQuality(node: number | string, pollutant: number | string, conc: number): void {
    const n = resolveIndex(this._raw, this._h, "node", node);
    raiseForCode(this._raw.swmm_node_set_quality(this._h, n, this._resolve(pollutant), conc));
  }

  /** Set a link's concentration of a pollutant. */
  setLinkQuality(link: number | string, pollutant: number | string, conc: number): void {
    const l = resolveIndex(this._raw, this._h, "link", link);
    raiseForCode(this._raw.swmm_link_set_quality(this._h, l, this._resolve(pollutant), conc));
  }
}
