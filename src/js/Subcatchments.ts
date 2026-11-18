/**
 * @file Subcatchments.ts
 * @brief Subcatchment collection and individual subcatchment accessor.
 *
 * @details Mirrors the Python `_subcatchments.pyi` binding specification.
 *
 * @author   Caleb Buahin <caleb.buahin@gmail.com>
 * @copyright Copyright (c) 2026 Caleb Buahin. All rights reserved.
 * @license  Apache-2.0
 */

import { ElementNotFoundError, StaleObjectError, raiseForCode } from "./errors.js";
import type { OpenSwmmWasmModule } from "./types.js";
import type { RawApi } from "./raw.js";
import type { ModelBuilder } from "./ModelBuilder.js";
import type { Solver } from "./Solver.js";
import { checkedAlloc, guardedRaw, withCString, withCStrings } from "./mem.js";
import { InfilModel } from "./enums.js";
import {
  bulkRead,
  getDouble,
  getDoubles,
  getInt,
  getText,
  resolveIndex,
  type ElementCtx,
} from "./element.js";
import type { Gage } from "./Gages.js";
import type { Node } from "./Nodes.js";

// =============================================================================
// Subcatchment sub-views (Python SubcatchmentStatsView, InfiltrationView,
// CoverageView, LoadingsView) and GroundwaterParams
// =============================================================================

/** Groundwater flow coefficients of a subcatchment (Python `GroundwaterParams`). */
export interface GroundwaterParams {
  surfElev: number;
  a1: number;
  b1: number;
  a2: number;
  b2: number;
  a3: number;
  tw: number;
  hstar: number;
}

/** Accumulated statistics of a subcatchment (`sub.stats`). */
export class SubcatchmentStatsView {
  /** @internal */
  constructor(private readonly _sub: Subcatchment) {}

  /** Total precipitation. */
  get precip(): number {
    const c = this._sub._ctx();
    return getDouble(c, c.raw.swmm_subcatch_get_stat_precip);
  }
  /** Total runoff volume. */
  get runoffVol(): number {
    const c = this._sub._ctx();
    return getDouble(c, c.raw.swmm_subcatch_get_stat_runoff_vol);
  }
  /** Peak runoff rate. */
  get maxRunoff(): number {
    const c = this._sub._ctx();
    return getDouble(c, c.raw.swmm_subcatch_get_stat_max_runoff);
  }
}

/** Infiltration model and parameters (`sub.infiltration`). */
export class InfiltrationView {
  /** @internal */
  constructor(private readonly _sub: Subcatchment) {}

  /** Infiltration model ({@link InfilModel}); changing it keeps each model's parameters. */
  get model(): InfilModel {
    const c = this._sub._ctx();
    return getInt(c, c.raw.swmm_subcatch_get_infil_model) as InfilModel;
  }
  set model(value: InfilModel) {
    const c = this._sub._ctx();
    raiseForCode(c.raw.swmm_subcatch_set_infil_model(c.engine, c.index, value));
  }

  /** Horton `[f0, fmin, decay, dryTime]`. */
  get horton(): [number, number, number, number] {
    const c = this._sub._ctx();
    return getDoubles(c, 4, c.raw.swmm_subcatch_get_infil_horton) as [
      number,
      number,
      number,
      number,
    ];
  }
  /** Set the Horton parameters. */
  setHorton(f0: number, fmin: number, decay: number, dryTime: number): void {
    const c = this._sub._ctx();
    raiseForCode(c.raw.swmm_subcatch_set_infil_horton(c.engine, c.index, f0, fmin, decay, dryTime));
  }

  /** Green-Ampt `[suction, conductivity, initialDeficit]`. */
  get greenAmpt(): [number, number, number] {
    const c = this._sub._ctx();
    return getDoubles(c, 3, c.raw.swmm_subcatch_get_infil_green_ampt) as [number, number, number];
  }
  /** Set the Green-Ampt parameters. */
  setGreenAmpt(suction: number, conductivity: number, initialDeficit: number): void {
    const c = this._sub._ctx();
    raiseForCode(
      c.raw.swmm_subcatch_set_infil_green_ampt(
        c.engine,
        c.index,
        suction,
        conductivity,
        initialDeficit,
      ),
    );
  }

  /** SCS curve number. */
  get curveNumber(): number {
    const c = this._sub._ctx();
    return getDoubles(c, 2, c.raw.swmm_subcatch_get_infil_curve_number)[0];
  }
  /** Curve-number drying time. */
  get curveNumberDryingTime(): number {
    const c = this._sub._ctx();
    return getDoubles(c, 2, c.raw.swmm_subcatch_get_infil_curve_number)[1];
  }
  /** Set the curve number and drying time. */
  setCurveNumber(cn: number, dryingTime: number): void {
    const c = this._sub._ctx();
    raiseForCode(c.raw.swmm_subcatch_set_infil_curve_number(c.engine, c.index, cn, dryingTime));
  }
}

/**
 * Land-use coverage fractions (`sub.coverage`, `[COVERAGES]`) by land use
 * index or id; iteration yields the land uses with a nonzero fraction.
 */
export class CoverageView implements Iterable<string> {
  /** @internal */
  constructor(private readonly _sub: Subcatchment) {}

  /** Fraction of the subcatchment under a land use. */
  get(landuse: number | string): number {
    const c = this._sub._ctx();
    const lu = resolveIndex(c.raw, c.engine, "landuse", landuse);
    return getDouble(c, (e, i, out) => c.raw.swmm_subcatch_get_coverage(e, i, lu, out));
  }
  /** Set the fraction under a land use. */
  set(landuse: number | string, value: number): void {
    const c = this._sub._ctx();
    const lu = resolveIndex(c.raw, c.engine, "landuse", landuse);
    raiseForCode(c.raw.swmm_subcatch_set_coverage(c.engine, c.index, lu, value));
  }
  /** Coverage entries cannot be deleted; set the fraction to 0 instead. @throws TypeError */
  delete(landuse: number | string): never {
    void landuse;
    throw new TypeError("coverage entries can't be deleted; set fraction to 0.0 instead");
  }
  /** Number of land uses with a nonzero fraction. */
  get length(): number {
    return [...this].length;
  }
  [Symbol.iterator](): Iterator<string> {
    const c = this._sub._ctx();
    const ids = Array.from({ length: c.raw.swmm_landuse_count(c.engine) }, (_, i) =>
      c.raw.swmm_landuse_id(c.engine, i),
    ).filter((id) => id && this.get(id) !== 0);
    return ids[Symbol.iterator]();
  }
}

/**
 * Initial buildup per pollutant or reaction species (`sub.loadings`,
 * `[LOADINGS]`); iteration yields the pollutants with a nonzero loading.
 */
export class LoadingsView implements Iterable<string> {
  /** @internal */
  constructor(private readonly _sub: Subcatchment) {}

  /** @internal A pollutant id/index, or a reaction species name (addressed after the pollutants). */
  private _species(c: ElementCtx, key: number | string): number {
    const np = c.raw.swmm_pollutant_count(c.engine);
    const nm = c.raw.swmm_reaction_species_count(c.engine);
    if (typeof key === "number") {
      if (!Number.isInteger(key) || key < 0 || key >= np + nm) {
        throw new ElementNotFoundError(
          key,
          `Pollutant/species index ${key} out of range [0, ${np + nm})`,
        );
      }
      return key;
    }
    const i = c.raw.swmm_pollutant_index(c.engine, key);
    if (i >= 0) return i;
    const scratch = checkedAlloc(c.mod, 24);
    try {
      for (let m = 0; m < nm; m++) {
        const [name] = withCStrings(c.mod, 256, 2, ([n, u], len) =>
          c.raw.swmm_reaction_species_get(
            c.engine,
            m,
            n,
            len,
            scratch,
            u,
            len,
            scratch + 8,
            scratch + 16,
          ),
        );
        if (name === key) return np + m;
      }
    } finally {
      c.mod._free(scratch);
    }
    throw new ElementNotFoundError(key, `Pollutant or species '${key}' not found`);
  }

  /** Initial loading (mass per area) of a pollutant or species. */
  get(species: number | string): number {
    const c = this._sub._ctx();
    const p = this._species(c, species);
    return getDouble(c, (e, i, out) => c.raw.swmm_subcatch_get_initial_loading(e, i, p, out));
  }
  /** Set the initial loading of a pollutant or species. */
  set(species: number | string, value: number): void {
    const c = this._sub._ctx();
    const p = this._species(c, species);
    raiseForCode(c.raw.swmm_subcatch_set_initial_loading(c.engine, c.index, p, value));
  }
  /** Loadings cannot be deleted; set the value to 0 instead. @throws TypeError */
  delete(species: number | string): never {
    void species;
    throw new TypeError("loading entries can't be deleted; set the value to 0.0 instead");
  }
  /** Number of pollutants with a nonzero loading. */
  get length(): number {
    return [...this].length;
  }
  [Symbol.iterator](): Iterator<string> {
    const c = this._sub._ctx();
    const ids = Array.from({ length: c.raw.swmm_pollutant_count(c.engine) }, (_, i) =>
      c.raw.swmm_pollutant_id(c.engine, i),
    ).filter((id) => id && this.get(id) !== 0);
    return ids[Symbol.iterator]();
  }
}

// =============================================================================
// Subcatchment
// =============================================================================

/**
 * Accessor for a single SWMM subcatchment.
 *
 * Obtain instances via {@link Subcatchments.get} — do not construct directly.
 */
export class Subcatchment {
  /** @internal */
  private readonly _mod: OpenSwmmWasmModule;
  private readonly _raw: RawApi;
  /** @internal */
  private readonly _engine: number;
  /** @internal */
  private readonly _collection: Subcatchments;
  /** @internal */
  private readonly _generation: number;

  /** Zero-based index of this subcatchment in the model's subcatchment list. */
  readonly index: number;

  /** @internal */
  constructor(
    mod: OpenSwmmWasmModule,
    engine: number,
    collection: Subcatchments,
    generation: number,
    index: number,
  ) {
    this._mod = mod;
    this._raw = guardedRaw(mod, () => collection.assertAlive());
    this._engine = engine;
    this._collection = collection;
    this._generation = generation;
    this.index = index;
  }

  /** @internal */
  private _checkStale(): void {
    if (this._generation !== this._collection.generation) {
      throw new StaleObjectError();
    }
  }

  /** @internal This subcatchment's engine context, after the staleness check. */
  _ctx(): ElementCtx {
    this._checkStale();
    return { mod: this._mod, raw: this._raw, engine: this._engine, index: this.index };
  }

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  /** String identifier of this subcatchment. */
  get id(): string {
    this._checkStale();
    return this._raw.swmm_subcatch_id(this._engine, this.index);
  }

  // -------------------------------------------------------------------------
  // Hydrologic state
  // -------------------------------------------------------------------------

  /** Current surface runoff rate (flow units). */
  get runoff(): number {
    this._checkStale();
    const ptr = checkedAlloc(this._mod, 8);
    try {
      raiseForCode(this._raw.swmm_subcatch_get_runoff(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  // -------------------------------------------------------------------------
  // Physical properties
  // -------------------------------------------------------------------------

  /** Subcatchment drainage area (ha or acres). */
  get area(): number {
    this._checkStale();
    const ptr = checkedAlloc(this._mod, 8);
    try {
      raiseForCode(this._raw.swmm_subcatch_get_area(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Percent impervious (0–100). */
  get impervPct(): number {
    this._checkStale();
    const ptr = checkedAlloc(this._mod, 8);
    try {
      raiseForCode(this._raw.swmm_subcatch_get_imperv_pct(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Representative width used for overland flow routing (m or ft). */
  get width(): number {
    this._checkStale();
    const ptr = checkedAlloc(this._mod, 8);
    try {
      raiseForCode(this._raw.swmm_subcatch_get_width(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Land surface slope (%). */
  get slope(): number {
    this._checkStale();
    const ptr = checkedAlloc(this._mod, 8);
    try {
      raiseForCode(this._raw.swmm_subcatch_get_slope(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  // -------------------------------------------------------------------------
  // Topology
  // -------------------------------------------------------------------------

  /** Zero-based index of the outlet node, or -1 if draining to another subcatchment. */
  get outletNodeIndex(): number {
    this._checkStale();
    const ptr = checkedAlloc(this._mod, 4);
    try {
      raiseForCode(this._raw.swmm_subcatch_get_outlet(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "i32");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Zero-based index of the assigned rain gage. */
  get gageIndex(): number {
    this._checkStale();
    const ptr = checkedAlloc(this._mod, 4);
    try {
      raiseForCode(this._raw.swmm_subcatch_get_gage(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "i32");
    } finally {
      this._mod._free(ptr);
    }
  }

  // -------------------------------------------------------------------------
  // Python Subcatchment members (wave B)
  // -------------------------------------------------------------------------

  /** The solver (or model builder) this subcatchment belongs to. */
  get solver(): Solver | ModelBuilder | null {
    return this._collection.solver;
  }

  /** @internal The owner, which every cross-collection view needs. */
  private _owner(): Solver | ModelBuilder {
    const owner = this._collection.solver;
    if (!owner) throw new ElementNotFoundError(this.index, "subcatchment has no owner");
    return owner;
  }

  /** The subcatchment's tag (`[TAGS]`). */
  get tag(): string {
    const c = this._ctx();
    return getText(c, c.raw.swmm_subcatch_get_tag);
  }
  set tag(value: string) {
    const c = this._ctx();
    raiseForCode(c.raw.swmm_subcatch_set_tag(c.engine, c.index, value ?? ""));
  }

  /** Assigned snowpack name (`""` = none). */
  get snowpack(): string {
    const c = this._ctx();
    return c.raw.swmm_subcatch_get_snowpack(c.engine, c.index) ?? "";
  }
  set snowpack(value: string) {
    if ((value ?? "").includes("\0")) throw new RangeError("Snow-pack names cannot contain NUL");
    const c = this._ctx();
    raiseForCode(c.raw.swmm_subcatch_set_snowpack(c.engine, c.index, value ?? ""));
  }

  /** @internal A double property through get/set functions. */
  private _get(fn: (e: number, i: number, out: number) => number): number {
    return getDouble(this._ctx(), fn);
  }

  /** Rainfall multiplier. */
  get rainScaleFactor(): number {
    return this._get(this._ctx().raw.swmm_subcatch_get_rain_scale_factor);
  }
  set rainScaleFactor(value: number) {
    const c = this._ctx();
    raiseForCode(c.raw.swmm_subcatch_set_rain_scale_factor(c.engine, c.index, value));
  }

  /** Snowfall multiplier. */
  get snowScaleFactor(): number {
    return this._get(this._ctx().raw.swmm_subcatch_get_snow_scale_factor);
  }
  set snowScaleFactor(value: number) {
    const c = this._ctx();
    raiseForCode(c.raw.swmm_subcatch_set_snow_scale_factor(c.engine, c.index, value));
  }

  /** Percent of the impervious area with no depression storage. */
  get zeroImpervPct(): number {
    return this._get(this._ctx().raw.swmm_subcatch_get_zero_imperv_pct);
  }
  set zeroImpervPct(value: number) {
    const c = this._ctx();
    raiseForCode(c.raw.swmm_subcatch_set_zero_imperv_pct(c.engine, c.index, value));
  }

  /** Manning n of the impervious area. */
  get nImperv(): number {
    return this._get(this._ctx().raw.swmm_subcatch_get_n_imperv);
  }
  set nImperv(value: number) {
    const c = this._ctx();
    raiseForCode(c.raw.swmm_subcatch_set_n_imperv(c.engine, c.index, value));
  }

  /** Manning n of the pervious area. */
  get nPerv(): number {
    return this._get(this._ctx().raw.swmm_subcatch_get_n_perv);
  }
  set nPerv(value: number) {
    const c = this._ctx();
    raiseForCode(c.raw.swmm_subcatch_set_n_perv(c.engine, c.index, value));
  }

  /** Depression storage of the impervious area. */
  get dsImperv(): number {
    return this._get(this._ctx().raw.swmm_subcatch_get_ds_imperv);
  }
  set dsImperv(value: number) {
    const c = this._ctx();
    raiseForCode(c.raw.swmm_subcatch_set_ds_imperv(c.engine, c.index, value));
  }

  /** Depression storage of the pervious area. */
  get dsPerv(): number {
    return this._get(this._ctx().raw.swmm_subcatch_get_ds_perv);
  }
  set dsPerv(value: number) {
    const c = this._ctx();
    raiseForCode(c.raw.swmm_subcatch_set_ds_perv(c.engine, c.index, value));
  }

  /** The rain gage. Assign a gage view, index or id. */
  get gage(): Gage {
    return this._owner().gages.get(this.gageIndex);
  }
  set gage(value: Gage | number | string) {
    const c = this._ctx();
    const gi =
      typeof value === "object" ? value.index : resolveIndex(c.raw, c.engine, "gage", value);
    raiseForCode(c.raw.swmm_subcatch_set_gage(c.engine, c.index, gi));
  }

  /** Where the runoff goes: a node, another subcatchment, or `null`. */
  get outlet(): Node | Subcatchment | null {
    const c = this._ctx();
    const p = checkedAlloc(c.mod, 4);
    try {
      if (c.raw.swmm_subcatch_get_outlet(c.engine, c.index, p) === 0 && c.mod.HEAP32[p >> 2] >= 0) {
        return this._owner().nodes.get(c.mod.HEAP32[p >> 2]);
      }
      raiseForCode(c.raw.swmm_subcatch_get_outlet_subcatch(c.engine, c.index, p));
      const s = c.mod.HEAP32[p >> 2];
      return s >= 0 ? this._owner().subcatchments.get(s) : null;
    } finally {
      c.mod._free(p);
    }
  }

  /** Send the runoff to a node (view, index or id). */
  setOutletNode(node: Node | number | string): void {
    const c = this._ctx();
    const ni = typeof node === "object" ? node.index : resolveIndex(c.raw, c.engine, "node", node);
    raiseForCode(c.raw.swmm_subcatch_set_outlet(c.engine, c.index, ni));
  }

  /** Send the runoff to another subcatchment (view, index or id). */
  setOutletSubcatchment(sub: Subcatchment | number | string): void {
    const c = this._ctx();
    const si = typeof sub === "object" ? sub.index : resolveIndex(c.raw, c.engine, "subcatch", sub);
    raiseForCode(c.raw.swmm_subcatch_set_outlet_subcatch(c.engine, c.index, si));
  }

  /** Index of the aquifer (`null` = none). Assign an index, id or `null`. */
  get aquifer(): number | null {
    const c = this._ctx();
    const v = getInt(c, c.raw.swmm_subcatch_get_aquifer);
    return v < 0 ? null : v;
  }
  set aquifer(value: number | string | null) {
    const c = this._ctx();
    const ai = value === null ? -1 : resolveIndex(c.raw, c.engine, "aquifer", value);
    raiseForCode(c.raw.swmm_subcatch_set_aquifer(c.engine, c.index, ai));
  }

  /** Index of the groundwater receiving node (`null` = none). */
  get gwNode(): number | null {
    const c = this._ctx();
    const v = getInt(c, c.raw.swmm_subcatch_get_gw_node);
    return v < 0 ? null : v;
  }
  set gwNode(value: Node | number | string | null) {
    const c = this._ctx();
    const ni =
      value === null
        ? -1
        : typeof value === "object"
          ? value.index
          : resolveIndex(c.raw, c.engine, "node", value);
    raiseForCode(c.raw.swmm_subcatch_set_gw_node(c.engine, c.index, ni));
  }

  /** Groundwater flow coefficients. */
  get gwParams(): GroundwaterParams {
    const c = this._ctx();
    const [surfElev, a1, b1, a2, b2, a3, tw, hstar] = getDoubles(
      c,
      8,
      c.raw.swmm_subcatch_get_gw_params,
    );
    return { surfElev, a1, b1, a2, b2, a3, tw, hstar };
  }

  /** Set the groundwater flow coefficients. */
  setGwParams(
    surfElev: number,
    a1: number,
    b1: number,
    a2: number,
    b2: number,
    a3: number,
    tw: number,
    hstar: number,
  ): void {
    const c = this._ctx();
    raiseForCode(
      c.raw.swmm_subcatch_set_gw_params(c.engine, c.index, surfElev, a1, b1, a2, b2, a3, tw, hstar),
    );
  }

  /** Groundwater flow from the aquifer. */
  get groundwater(): number {
    return this._get(this._ctx().raw.swmm_subcatch_get_groundwater);
  }

  /** Current rainfall rate. */
  get rainfall(): number {
    return this._get(this._ctx().raw.swmm_subcatch_get_rainfall);
  }
  set rainfall(value: number) {
    const c = this._ctx();
    raiseForCode(c.raw.swmm_subcatch_set_rainfall(c.engine, c.index, value));
  }

  /** Snow depth. */
  get snowDepth(): number {
    return this._get(this._ctx().raw.swmm_subcatch_get_snow_depth);
  }

  /** Evaporation rate. */
  get evap(): number {
    return this._get(this._ctx().raw.swmm_subcatch_get_evap);
  }

  /** Infiltration rate. */
  get infil(): number {
    return this._get(this._ctx().raw.swmm_subcatch_get_infil);
  }

  /** Runoff concentration of a pollutant (by index or id). */
  quality(pollutant: number | string): number {
    const c = this._ctx();
    const q = resolveIndex(c.raw, c.engine, "pollutant", pollutant);
    return getDouble(c, (e, i, out) => c.raw.swmm_subcatch_get_quality(e, i, q, out));
  }

  /** Ponded mass of a pollutant. */
  pondedQuality(pollutant: number | string): number {
    const c = this._ctx();
    const q = resolveIndex(c.raw, c.engine, "pollutant", pollutant);
    return getDouble(c, (e, i, out) => c.raw.swmm_subcatch_get_ponded_quality(e, i, q, out));
  }

  /** Set the ponded mass of a pollutant. */
  setPondedQuality(pollutant: number | string, mass: number): void {
    const c = this._ctx();
    const q = resolveIndex(c.raw, c.engine, "pollutant", pollutant);
    raiseForCode(c.raw.swmm_subcatch_set_ponded_quality(c.engine, c.index, q, mass));
  }

  /** Set the groundwater state; -1 keeps a value. */
  setGwState(theta = -1, lowerDepth = -1): void {
    const c = this._ctx();
    raiseForCode(c.raw.swmm_subcatch_set_gw_state(c.engine, c.index, theta, lowerDepth));
  }

  /** `[theta, lowerDepth]` of the groundwater. */
  getGwState(): [number, number] {
    const c = this._ctx();
    return getDoubles(c, 2, c.raw.swmm_subcatch_get_gw_state) as [number, number];
  }

  /** Set the snow state of a surface (0 plowable, 1 impervious, 2 pervious); -1 (ati: -1000) keeps a value. */
  setSnowState(surface: number, swe = -1, fw = -1, ati = -1000, coldc = -1): void {
    const c = this._ctx();
    raiseForCode(
      c.raw.swmm_subcatch_set_snow_state(c.engine, c.index, surface, swe, fw, ati, coldc),
    );
  }

  /** `[swe, fw, ati, coldc]` of a surface's snow. */
  getSnowState(surface: number): [number, number, number, number] {
    const c = this._ctx();
    return getDoubles(c, 4, (e, i, ...outs) =>
      c.raw.swmm_subcatch_get_snow_state(e, i, surface, outs[0], outs[1], outs[2], outs[3]),
    ) as [number, number, number, number];
  }

  /** Accumulated statistics. */
  get stats(): SubcatchmentStatsView {
    return new SubcatchmentStatsView(this);
  }

  /** Infiltration model and parameters. */
  get infiltration(): InfiltrationView {
    return new InfiltrationView(this);
  }

  /** Land-use coverage fractions. */
  get coverage(): CoverageView {
    return new CoverageView(this);
  }

  /** Coverage fraction of every land use, in land-use order (one C call). */
  coverages(): number[] {
    const c = this._ctx();
    const n = c.raw.swmm_landuse_count(c.engine);
    if (n <= 0) return [];
    return Array.from(
      bulkRead(c.mod, n, (p, k) => c.raw.swmm_subcatch_get_coverages(c.engine, c.index, p, k)),
    );
  }

  /** Initial pollutant loadings. */
  get loadings(): LoadingsView {
    return new LoadingsView(this);
  }
}

// =============================================================================
// Subcatchments collection
// =============================================================================

/**
 * Iterable collection of all subcatchments in the current model.
 *
 * Obtain via {@link Solver.subcatchments}.
 *
 * @example
 * ```ts
 * for (const sc of solver.subcatchments) {
 *   console.log(sc.id, sc.runoff);
 * }
 * ```
 */
export class Subcatchments implements Iterable<Subcatchment> {
  /** @internal */
  private readonly _mod: OpenSwmmWasmModule;
  private readonly _raw: RawApi;
  /** @internal */
  private readonly _engine: number;

  /** @internal */
  generation: number = 0;

  /** @internal */
  /** @internal Check the owner before touching native memory. */
  assertAlive(): void {
    this._checkOwner();
  }

  constructor(
    mod: OpenSwmmWasmModule,
    engine: number,
    private readonly _checkOwner: () => void = () => {},
    /** The solver (or model builder) that owns the collection. */
    readonly solver: Solver | ModelBuilder | null = null,
  ) {
    this._mod = mod;
    this._raw = guardedRaw(mod, this._checkOwner);
    this._engine = engine;
  }

  // -------------------------------------------------------------------------
  // Collection interface
  // -------------------------------------------------------------------------

  /** Number of subcatchments in the model. */
  get length(): number {
    return this._raw.swmm_subcatch_count(this._engine);
  }

  /**
   * Look up a subcatchment by zero-based index or string ID.
   *
   * @throws {@link ElementNotFoundError} if not found.
   */
  get(indexOrId: number | string): Subcatchment {
    if (typeof indexOrId === "string") {
      const idx = this._raw.swmm_subcatch_index(this._engine, indexOrId);
      if (idx < 0) throw new ElementNotFoundError(indexOrId);
      return new Subcatchment(this._mod, this._engine, this, this.generation, idx);
    }
    const count = this.length;
    if (indexOrId < 0 || indexOrId >= count) {
      throw new ElementNotFoundError(
        indexOrId,
        `Subcatchment index ${indexOrId} out of range [0, ${count})`,
      );
    }
    return new Subcatchment(this._mod, this._engine, this, this.generation, indexOrId);
  }

  /** True when a subcatchment with this index or id exists. */
  has(key: number | string): boolean {
    if (typeof key === "string") return this.getIndex(key) >= 0;
    return Number.isInteger(key) && key >= 0 && key < this.length;
  }

  /** Every subcatchment id, in index order. */
  get ids(): string[] {
    return Array.from({ length: this.length }, (_, i) => this.getId(i));
  }

  /** Add a subcatchment; earlier subcatchment views become stale, as in Python. */
  add(subId: string): Subcatchment {
    raiseForCode(this._raw.swmm_subcatch_add(this._engine, subId));
    this.generation++;
    return this.get(subId);
  }

  /** Rename a subcatchment; references follow. Earlier views become stale. */
  rename(key: number | string, newId: string): void {
    raiseForCode(this._raw.swmm_subcatch_rename(this._engine, this.get(key).index, newId));
    this.generation++;
  }

  /** Rainfall of every subcatchment. */
  get rainfalls(): Float64Array {
    return bulkRead(this._mod, this.length, (p, n) =>
      this._raw.swmm_subcatch_get_rainfall_bulk(this._engine, p, n),
    );
  }

  /** Evaporation of every subcatchment. */
  get evaps(): Float64Array {
    return bulkRead(this._mod, this.length, (p, n) =>
      this._raw.swmm_subcatch_get_evap_bulk(this._engine, p, n),
    );
  }

  /** Infiltration of every subcatchment. */
  get infils(): Float64Array {
    return bulkRead(this._mod, this.length, (p, n) =>
      this._raw.swmm_subcatch_get_infil_bulk(this._engine, p, n),
    );
  }

  /** Snow depth of every subcatchment. */
  get snowDepths(): Float64Array {
    return bulkRead(this._mod, this.length, (p, n) =>
      this._raw.swmm_subcatch_get_snow_depth_bulk(this._engine, p, n),
    );
  }

  /** Runoff concentration of a pollutant (by index or id) for every subcatchment. */
  qualities(pollutant: number | string): Float64Array {
    const q = resolveIndex(this._raw, this._engine, "pollutant", pollutant);
    return bulkRead(this._mod, this.length, (p, n) =>
      this._raw.swmm_subcatch_get_quality_bulk(this._engine, q, p, n),
    );
  }

  /** A subcatchment's custom groundwater flow expression ({@link GwfType}). */
  getGwfExpression(key: number | string, gwfType: number): string {
    const idx = this.get(key).index;
    return withCString(this._mod, 1024, (buf, len) =>
      this._raw.swmm_subcatch_get_gwf_expression(this._engine, idx, gwfType, buf, len),
    );
  }

  /** Set (or with `""` clear) a custom groundwater flow expression. */
  setGwfExpression(key: number | string, gwfType: number, expression: string): void {
    const idx = this.get(key).index;
    raiseForCode(
      this._raw.swmm_subcatch_set_gwf_expression(this._engine, idx, gwfType, expression ?? ""),
    );
  }

  /** Check an expression: `[ok, message, column]` (column -1 when ok). */
  validateGwfExpression(expression: string): [boolean, string, number] {
    const p = checkedAlloc(this._mod, 512 + 4);
    try {
      this._mod.HEAPU8[p] = 0;
      this._mod.HEAP32[(p + 512) >> 2] = -1;
      const rc = this._raw.swmm_gwf_validate_expression(this._engine, expression, p, 512, p + 512);
      if (rc === 0) return [true, "", -1];
      return [false, this._mod.UTF8ToString(p, 512), this._mod.HEAP32[(p + 512) >> 2]];
    } finally {
      this._mod._free(p);
    }
  }

  /** Variables a groundwater expression may use: `[name, description]`. */
  gwfVariables(): [string, string][] {
    const n = this._raw.swmm_gwf_variable_count(this._engine);
    return Array.from({ length: n }, (_, i) => [
      withCString(this._mod, 64, (buf, len) =>
        this._raw.swmm_gwf_variable_name(this._engine, i, buf, len),
      ),
      withCString(this._mod, 256, (buf, len) =>
        this._raw.swmm_gwf_variable_description(this._engine, i, buf, len),
      ),
    ]);
  }

  /** Functions a groundwater expression may call. */
  gwfFunctions(): string[] {
    const n = this._raw.swmm_gwf_function_count(this._engine);
    return Array.from({ length: n }, (_, i) =>
      withCString(this._mod, 64, (buf, len) =>
        this._raw.swmm_gwf_function_name(this._engine, i, buf, len),
      ),
    );
  }

  /** Return the zero-based index for a string subcatchment ID, or -1. */
  getIndex(id: string): number {
    return this._raw.swmm_subcatch_index(this._engine, id);
  }

  /** Return the string ID for a zero-based subcatchment index. */
  getId(idx: number): string {
    const id = this._raw.swmm_subcatch_id(this._engine, idx);
    if (!id) throw new ElementNotFoundError(idx, `Subcatchment index ${idx} out of range`);
    return id;
  }

  // -------------------------------------------------------------------------
  // Bulk array accessors
  // -------------------------------------------------------------------------

  /** Runoff rates of all subcatchments (flow units). */
  get runoffs(): Float64Array {
    const n = this.length;
    const result = new Float64Array(n);
    const ptr = checkedAlloc(this._mod, 8);
    try {
      for (let i = 0; i < n; i++) {
        raiseForCode(this._raw.swmm_subcatch_get_runoff(this._engine, i, ptr));
        result[i] = this._mod.getValue(ptr, "double");
      }
    } finally {
      this._mod._free(ptr);
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Iteration
  // -------------------------------------------------------------------------

  [Symbol.iterator](): Iterator<Subcatchment> {
    let i = 0;
    const length = this.length;
    return {
      next: (): IteratorResult<Subcatchment> => {
        if (i < length) {
          return { value: this.get(i++), done: false };
        }
        return { value: undefined as unknown as Subcatchment, done: true };
      },
    };
  }
}
