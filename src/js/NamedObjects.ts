/**
 * @file NamedObjects.ts
 * @brief `solver.aquifers` and `solver.snowpacks` (Python `Aquifers`,
 *        `Snowpacks` in `openswmm.engine._subcatchments`).
 *
 * Both collections hold named objects reached by index or id; the C API gives
 * count/index/id/add/rename plus per-kind parameters. Adding or renaming
 * invalidates the solver's views, as in Python.
 *
 * @license  Apache-2.0
 */

import { ElementNotFoundError, raiseForCode } from "./errors.js";
import { getDoubles, getText, type ElementCtx } from "./element.js";
import { guardedRaw, withDouble } from "./mem.js";
import type { RawApi } from "./raw.js";
import type { Solver } from "./Solver.js";

/** Collection of named objects (Python `_NamedObjects`). */
abstract class NamedObjects implements Iterable<string> {
  /** @internal */
  protected readonly _raw: RawApi;

  /** @internal */
  constructor(protected readonly _solver: Solver) {
    this._raw = guardedRaw(_solver.module, () => void _solver.handle);
  }

  /** @internal */
  protected abstract _count(): number;
  /** @internal */
  protected abstract _index(id: string): number;
  /** @internal */
  protected abstract _id(idx: number): string;
  /** @internal */
  protected abstract _add(id: string): number;
  /** @internal */
  protected abstract _rename(idx: number, newId: string): number;

  /** @internal */
  protected get _h(): number {
    return this._solver.handle;
  }

  /** @internal Context for one object, by index or id. */
  protected _ctx(key: number | string): ElementCtx {
    return { mod: this._solver.module, raw: this._raw, engine: this._h, index: this._key(key) };
  }

  /** @internal */
  protected _key(key: number | string): number {
    return typeof key === "number" ? key : this.getIndex(key);
  }

  /** Number of objects. */
  get length(): number {
    return this._count();
  }

  /** Index of an id. @throws ElementNotFoundError */
  getIndex(objId: string): number {
    const i = this._index(objId);
    if (i < 0) throw new ElementNotFoundError(objId);
    return i;
  }

  /** Id at an index (`""` when out of range). */
  getId(idx: number): string {
    return this._id(idx) ?? "";
  }

  /** True when an object with this index or id exists. */
  has(key: number | string): boolean {
    if (typeof key === "string") return this._index(key) >= 0;
    return Number.isInteger(key) && key >= 0 && key < this._count();
  }

  /** The ids, in index order. */
  [Symbol.iterator](): Iterator<string> {
    return Array.from({ length: this._count() }, (_, i) => this.getId(i))[Symbol.iterator]();
  }

  /** Add an object; returns its index. Invalidates the solver's views. */
  add(objId: string): number {
    raiseForCode(this._add(objId));
    this._solver._bumpGeneration();
    return this._count() - 1;
  }

  /** Rename an object; references follow. Invalidates the solver's views. */
  rename(key: number | string, newId: string): void {
    raiseForCode(this._rename(this._key(key), newId));
    this._solver._bumpGeneration();
  }
}

/** `solver.aquifers`: the `[AQUIFERS]` entries. */
export class Aquifers extends NamedObjects {
  protected _count(): number {
    return this._raw.swmm_aquifer_count(this._h);
  }
  protected _index(id: string): number {
    return this._raw.swmm_aquifer_index(this._h, id);
  }
  protected _id(idx: number): string {
    return this._raw.swmm_aquifer_id(this._h, idx);
  }
  protected _add(id: string): number {
    return this._raw.swmm_aquifer_add(this._h, id);
  }
  protected _rename(idx: number, newId: string): number {
    return this._raw.swmm_aquifer_rename(this._h, idx, newId);
  }

  /** One of the 12 numeric parameters ({@link AquiferParam}). */
  getParam(aquifer: number | string, param: number): number {
    const idx = this._key(aquifer);
    return withDouble(this._solver.module, (p) =>
      this._raw.swmm_aquifer_get_param(this._h, idx, param, p),
    );
  }

  /**
   * Set a numeric parameter. Flux coefficients take effect on the next step
   * mid-run; structural and initial-condition parameters are pre-start only
   * (LifecycleError while running).
   */
  setParam(aquifer: number | string, param: number, value: number): void {
    raiseForCode(this._raw.swmm_aquifer_set_param(this._h, this._key(aquifer), param, value));
  }

  /** Name of the aquifer's monthly evaporation pattern (`""` = none). */
  getEvapPattern(aquifer: number | string): string {
    const c = this._ctx(aquifer);
    return getText(c, c.raw.swmm_aquifer_get_evap_pattern);
  }

  /** Set the evaporation pattern (pre-start only; `""` clears). */
  setEvapPattern(aquifer: number | string, name: string): void {
    raiseForCode(this._raw.swmm_aquifer_set_evap_pattern(this._h, this._key(aquifer), name ?? ""));
  }
}

/** Snowpack surface parameters (plowable, impervious or pervious). */
export interface SnowSurface {
  cmin: number;
  cmax: number;
  tbase: number;
  fwfrac: number;
  sd0: number;
  fw0: number;
  last: number;
}

/** Snowpack removal (plowing) parameters. */
export interface SnowRemoval {
  dsnow: number;
  fout: number;
  fimp: number;
  fperv: number;
  fimelt: number;
  fsubcatch: number;
}

const SURFACE_FIELDS = ["cmin", "cmax", "tbase", "fwfrac", "sd0", "fw0", "last"] as const;
const REMOVAL_FIELDS = ["dsnow", "fout", "fimp", "fperv", "fimelt", "fsubcatch"] as const;

/** `solver.snowpacks`: the `[SNOWPACKS]` entries. */
export class Snowpacks extends NamedObjects {
  protected _count(): number {
    return this._raw.swmm_snowpack_count(this._h);
  }
  protected _index(id: string): number {
    return this._raw.swmm_snowpack_index(this._h, id);
  }
  protected _id(idx: number): string {
    return this._raw.swmm_snowpack_id(this._h, idx);
  }
  protected _add(id: string): number {
    return this._raw.swmm_snowpack_add(this._h, id);
  }
  protected _rename(idx: number, newId: string): number {
    return this._raw.swmm_snowpack_rename(this._h, idx, newId);
  }

  /** @internal */
  private _getSurface(
    snowpack: number | string,
    fn: (e: number, i: number, ...outs: number[]) => number,
  ): SnowSurface {
    const v = getDoubles(this._ctx(snowpack), 7, fn);
    return Object.fromEntries(SURFACE_FIELDS.map((k, i) => [k, v[i]])) as unknown as SnowSurface;
  }

  /** Plowable-area parameters. */
  getPlowable(snowpack: number | string): SnowSurface {
    return this._getSurface(snowpack, this._raw.swmm_snowpack_get_plowable);
  }
  /** Set the plowable-area parameters. */
  setPlowable(snowpack: number | string, s: SnowSurface): void {
    const v = SURFACE_FIELDS.map((k) => s[k]);
    raiseForCode(
      this._raw.swmm_snowpack_set_plowable(
        this._h,
        this._key(snowpack),
        ...(v as [number, number, number, number, number, number, number]),
      ),
    );
  }

  /** Impervious-area parameters. */
  getImpervious(snowpack: number | string): SnowSurface {
    return this._getSurface(snowpack, this._raw.swmm_snowpack_get_impervious);
  }
  /** Set the impervious-area parameters. */
  setImpervious(snowpack: number | string, s: SnowSurface): void {
    const v = SURFACE_FIELDS.map((k) => s[k]);
    raiseForCode(
      this._raw.swmm_snowpack_set_impervious(
        this._h,
        this._key(snowpack),
        ...(v as [number, number, number, number, number, number, number]),
      ),
    );
  }

  /** Pervious-area parameters. */
  getPervious(snowpack: number | string): SnowSurface {
    return this._getSurface(snowpack, this._raw.swmm_snowpack_get_pervious);
  }
  /** Set the pervious-area parameters. */
  setPervious(snowpack: number | string, s: SnowSurface): void {
    const v = SURFACE_FIELDS.map((k) => s[k]);
    raiseForCode(
      this._raw.swmm_snowpack_set_pervious(
        this._h,
        this._key(snowpack),
        ...(v as [number, number, number, number, number, number, number]),
      ),
    );
  }

  /** Removal (plowing) parameters. */
  getRemoval(snowpack: number | string): SnowRemoval {
    const v = getDoubles(this._ctx(snowpack), 6, this._raw.swmm_snowpack_get_removal);
    return Object.fromEntries(REMOVAL_FIELDS.map((k, i) => [k, v[i]])) as unknown as SnowRemoval;
  }
  /** Set the removal parameters. */
  setRemoval(snowpack: number | string, r: SnowRemoval): void {
    const v = REMOVAL_FIELDS.map((k) => r[k]);
    raiseForCode(
      this._raw.swmm_snowpack_set_removal(
        this._h,
        this._key(snowpack),
        ...(v as [number, number, number, number, number, number]),
      ),
    );
  }

  /** Subcatchment that receives plowed snow (`""` = none). */
  getRemovalSubcatch(snowpack: number | string): string {
    const c = this._ctx(snowpack);
    return getText(c, c.raw.swmm_snowpack_get_removal_subcatch);
  }
  /** Set (or with `""` clear) the subcatchment that receives plowed snow. */
  setRemovalSubcatch(snowpack: number | string, name: string): void {
    raiseForCode(
      this._raw.swmm_snowpack_set_removal_subcatch(this._h, this._key(snowpack), name ?? ""),
    );
  }
}
