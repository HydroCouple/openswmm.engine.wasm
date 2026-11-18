/**
 * @file WaterAge.ts
 * @brief `solver.waterAge`: the `[WATER_AGE_SOURCES]` table (Python
 *        `openswmm.engine._water_age`).
 *
 * A GLOBAL age per source pathway plus per-NODE overrides for `DWF` and
 * `EXTERNAL_INFLOW`. Values are in HOURS and signed: a negative source age
 * extracts age-volume (the engine keeps age at or above zero). Edits are
 * live: the loaders re-read the table every routing step.
 *
 * @license  Apache-2.0
 */

import { resolveIndex } from "./element.js";
import { WaterAgeSource } from "./enums.js";
import { ElementNotFoundError, raiseForCode } from "./errors.js";
import { checkedAlloc, withDouble, withInt } from "./mem.js";
import { SolverView } from "./view.js";

/** A source pathway: a {@link WaterAgeSource} code or its name (any case). */
export type WaterAgeSourceKey = WaterAgeSource | number | string;

const SOURCES = Object.values(WaterAgeSource).filter((v): v is number => typeof v === "number");

/** Python `_source`: a member, its code or its name (case-insensitive). */
function sourceOf(key: WaterAgeSourceKey): WaterAgeSource {
  if (typeof key === "string") {
    const code = (WaterAgeSource as unknown as Record<string, number>)[key.toUpperCase()];
    if (typeof code === "number") return code;
  } else if (SOURCES.includes(key)) {
    return key;
  }
  const valid = SOURCES.map((s) => WaterAgeSource[s]).join(", ");
  throw new ElementNotFoundError(
    String(key),
    `'${String(key)}' is not a valid WaterAgeSource; valid members: ${valid}`,
  );
}

/** One NODE-scope override row (only DWF and EXTERNAL_INFLOW). */
export interface WaterAgeOverride {
  readonly source: WaterAgeSource;
  readonly nodeIndex: number;
  /** Signed age in HOURS. */
  readonly hours: number;
}

/** `waterAge.globals`: GLOBAL source ages in HOURS, keyed by pathway (Python `_WaterAgeGlobals`). */
export class WaterAgeGlobals extends SolverView {
  /** Number of source pathways (7). */
  get length(): number {
    return SOURCES.length;
  }

  [Symbol.iterator](): Iterator<WaterAgeSource> {
    return SOURCES[Symbol.iterator]();
  }

  get(key: WaterAgeSourceKey): number {
    const s = sourceOf(key);
    return withDouble(this._mod, (p) => this._raw.swmm_water_age_get_global_source(this._h, s, p));
  }

  /** Set a pathway's GLOBAL age (negative extracts); live on the next routing step. */
  set(key: WaterAgeSourceKey, hours: number): void {
    raiseForCode(this._raw.swmm_water_age_set_global_source(this._h, sourceOf(key), hours));
  }

  has(key: WaterAgeSourceKey): boolean {
    try {
      sourceOf(key);
      return true;
    } catch {
      return false;
    }
  }
}

/** `waterAge.nodeOverrides`: NODE-scope rows by position (Python `_WaterAgeOverrides`). */
export class WaterAgeOverrides extends SolverView {
  get length(): number {
    return withInt(this._mod, (p) => this._raw.swmm_water_age_override_count(this._h, p));
  }

  *[Symbol.iterator](): Iterator<WaterAgeOverride> {
    const n = this.length;
    for (let i = 0; i < n; i++) yield this.get(i);
  }

  /** One row; negative indices count from the end. */
  get(rowIndex: number): WaterAgeOverride {
    const n = this.length;
    const i = rowIndex < 0 ? rowIndex + n : rowIndex;
    if (!(i >= 0 && i < n)) throw new RangeError(String(rowIndex));
    const mod = this._mod;
    const p = checkedAlloc(mod, 16);
    try {
      mod.HEAP32[p >> 2] = 0;
      mod.HEAP32[(p + 4) >> 2] = -1;
      mod.HEAPF64[(p + 8) >> 3] = 0;
      raiseForCode(this._raw.swmm_water_age_get_override(this._h, i, p, p + 4, p + 8));
      return {
        source: mod.HEAP32[p >> 2] as WaterAgeSource,
        nodeIndex: mod.HEAP32[(p + 4) >> 2],
        hours: mod.HEAPF64[(p + 8) >> 3],
      };
    } finally {
      mod._free(p);
    }
  }

  /**
   * Add or update the override of `(source, node)`. Only DWF and
   * EXTERNAL_INFLOW take NODE scope (others throw {@link BadParamError}).
   */
  set(source: WaterAgeSourceKey, node: number | string, hours: number): void {
    const s = sourceOf(source);
    const n = resolveIndex(this._raw, this._h, "node", node);
    raiseForCode(this._raw.swmm_water_age_set_override(this._h, s, n, hours));
    this._solver._bumpGeneration();
  }

  /** Remove the override of `(source, node)`; later rows may shift. */
  remove(source: WaterAgeSourceKey, node: number | string): void {
    const s = sourceOf(source);
    const n = resolveIndex(this._raw, this._h, "node", node);
    raiseForCode(this._raw.swmm_water_age_remove_override(this._h, s, n));
    this._solver._bumpGeneration();
  }
}

/** `solver.waterAge`: the `[WATER_AGE_SOURCES]` configuration. */
export class WaterAge extends SolverView {
  private _globals?: WaterAgeGlobals;
  private _overrides?: WaterAgeOverrides;

  /** Whether `[OPTIONS] WATER_AGE` is on. */
  get enabled(): boolean {
    return withInt(this._mod, (p) => this._raw.swmm_water_age_get_enabled(this._h, p)) !== 0;
  }

  /** GLOBAL source ages in HOURS. */
  get globals(): WaterAgeGlobals {
    return (this._globals ??= new WaterAgeGlobals(this._solver));
  }

  /** NODE-scope overrides (DWF and EXTERNAL_INFLOW only). */
  get nodeOverrides(): WaterAgeOverrides {
    return (this._overrides ??= new WaterAgeOverrides(this._solver));
  }

  /** Write the table as a `model.age` component file that reloads into the same table. */
  save(path: string): void {
    raiseForCode(this._raw.swmm_water_age_save(this._h, path));
  }
}
