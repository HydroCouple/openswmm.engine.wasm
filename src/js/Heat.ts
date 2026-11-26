/**
 * @file Heat.ts
 * @brief `solver.heat`: heat-transport configuration and diagnostics (Python
 *        `openswmm.engine._heat`).
 *
 * `[HEAT_FLUXES]` toggles, `[RADIATIVE_FLUXES]`, `[SOLAR_RADIATION]`,
 * `[CLOUD_COVER]` and `[SEDIMENT_EXCHANGE]` parameters, the `[HEAT_SOURCES]`
 * inlet temperatures with node overrides, per-element overrides, mesh,
 * ground and channel-ground diagnostics, snapshots and atomic edits. Edits
 * are live (re-read every routing step). Values are refused, never clamped:
 * a refused write throws and keeps the previous value. Enum keys accept a
 * member, its code or its name in any case.
 *
 * @license  Apache-2.0
 */

import {
  EngineState,
  ErrorCode,
  HeatAttr,
  HeatCloudParam,
  HeatFluxModule,
  HeatOverrideScope,
  HeatRadiativeParam,
  HeatSedimentParam,
  HeatShortwaveMode,
  HeatSolarParam,
  HeatSourceKind,
} from "./enums.js";
import { resolveIndex } from "./element.js";
import { ElementNotFoundError, StaleObjectError, raiseForCode } from "./errors.js";
import { checkedAlloc, rawOf, withCString, withCStrings, withDouble, withInt } from "./mem.js";
import { CALLBACK_SIGNATURES, STRUCTS, type RawApi } from "./raw.js";
import { readStruct, withStruct } from "./structs.js";
import type { Solver } from "./Solver.js";
import { SolverView } from "./view.js";

type EnumObject = Record<string, string | number>;

/** Python `_member`: an enum member, its code, or its name (case-insensitive). */
function member(enumObj: EnumObject, label: string, key: number | string): number {
  if (typeof key === "string") {
    const v = enumObj[key.toUpperCase()];
    if (typeof v === "number") return v;
  } else if (typeof enumObj[key] === "string") {
    return key;
  }
  const valid = Object.keys(enumObj)
    .filter((k) => typeof enumObj[k] === "number")
    .join(", ");
  throw new ElementNotFoundError(
    String(key),
    `'${String(key)}' is not a valid ${label}; valid members: ${valid}`,
  );
}

function codes(enumObj: EnumObject): number[] {
  return Object.values(enumObj).filter((v): v is number => typeof v === "number");
}

/** A mapping keyed by one enum's members, read and written through C calls. */
abstract class EnumTable<V> extends SolverView {
  /** @internal */
  protected abstract readonly _enum: EnumObject;
  /** @internal */
  protected abstract readonly _label: string;
  /** @internal */
  protected abstract _read(code: number): V;
  /** @internal */
  protected abstract _write(code: number, value: V): void;

  get length(): number {
    return codes(this._enum).length;
  }

  [Symbol.iterator](): Iterator<number> {
    return codes(this._enum)[Symbol.iterator]();
  }

  get(key: number | string): V {
    return this._read(member(this._enum, this._label, key));
  }

  set(key: number | string, value: V): void {
    this._write(member(this._enum, this._label, key), value);
  }

  /** @internal */
  protected _code(key: number | string): number {
    return member(this._enum, this._label, key);
  }

  /** @internal */
  protected _double(fn: (h: number, code: number, out: number) => number, code: number): number {
    return withDouble(this._mod, (p) => fn(this._h, code, p));
  }
}

/** `heat.modules`: `[HEAT_FLUXES]` toggles keyed by {@link HeatFluxModule} (Python `_HeatModules`). */
export class HeatModules extends EnumTable<boolean> {
  protected readonly _enum = HeatFluxModule as unknown as EnumObject;
  protected readonly _label = "HeatFluxModule";
  protected _read(code: number): boolean {
    return withInt(this._mod, (p) => this._raw.swmm_heat_get_module(this._h, code, p)) !== 0;
  }
  protected _write(code: number, on: boolean): void {
    raiseForCode(this._raw.swmm_heat_set_module(this._h, code, on ? 1 : 0));
  }
}

/**
 * `heat.radiative`: `[RADIATIVE_FLUXES]` keyed by {@link HeatRadiativeParam}
 * (Python `_HeatRadiative`). SHORTWAVE in W/m², LANDCOVER_TEMPERATURE in °C
 * (NaN inherits air), the rest fractions in [0, 1]. SHORTWAVE is writable in
 * CONSTANT shortwave mode only.
 */
export class HeatRadiative extends EnumTable<number> {
  protected readonly _enum = HeatRadiativeParam as unknown as EnumObject;
  protected readonly _label = "HeatRadiativeParam";
  protected _read(code: number): number {
    return this._double(this._raw.swmm_heat_get_radiative, code);
  }
  protected _write(code: number, value: number): void {
    raiseForCode(this._raw.swmm_heat_set_radiative(this._h, code, value));
  }
}

/**
 * `heat.solar`: `[SOLAR_RADIATION]` keyed by {@link HeatSolarParam}, read in
 * COMPUTED shortwave mode (Python `_HeatSolar`). Writing LATITUDE or
 * LONGITUDE marks it explicitly provided ({@link Heat.solarSited}).
 */
export class HeatSolar extends EnumTable<number> {
  protected readonly _enum = HeatSolarParam as unknown as EnumObject;
  protected readonly _label = "HeatSolarParam";
  protected _read(code: number): number {
    return this._double(this._raw.swmm_heat_get_solar, code);
  }
  protected _write(code: number, value: number): void {
    raiseForCode(this._raw.swmm_heat_set_solar(this._h, code, value));
  }

  /** Clear the shared site before initialization (COMPUTED mode then refuses it). */
  clear(): void {
    raiseForCode(this._raw.swmm_heat_clear_solar_site(this._h));
  }
}

/**
 * `heat.cloud`: `[CLOUD_COVER]` keyed by {@link HeatCloudParam} (Python
 * `_HeatCloud`). Writing any parameter marks cloud cover configured.
 */
export class HeatCloud extends EnumTable<number> {
  protected readonly _enum = HeatCloudParam as unknown as EnumObject;
  protected readonly _label = "HeatCloudParam";
  protected _read(code: number): number {
    return this._double(this._raw.swmm_heat_get_cloud, code);
  }
  protected _write(code: number, value: number): void {
    raiseForCode(this._raw.swmm_heat_set_cloud(this._h, code, value));
  }

  /** The bound time series name (`""` when none). */
  get timeseries(): string {
    return withCString(this._mod, 256, (buf, len) =>
      this._raw.swmm_heat_get_cloud_timeseries(this._h, buf, len),
    );
  }

  /** Whether a `[CLOUD_COVER]` section is in effect. */
  get configured(): boolean {
    return withInt(this._mod, (p) => this._raw.swmm_heat_get_cloud_configured(this._h, p)) !== 0;
  }

  /** Cloud fraction at the current step, [0, 1] (state, not configuration). */
  get current(): number {
    return withDouble(this._mod, (p) => this._raw.swmm_heat_get_current_cloud(this._h, p));
  }

  /** Bind a `[TIMESERIES]` as the cloud-fraction record. */
  setTimeseries(name: string): void {
    raiseForCode(this._raw.swmm_heat_set_cloud_timeseries(this._h, name));
  }

  /** Remove `[CLOUD_COVER]`: clear sky again. */
  clear(): void {
    raiseForCode(this._raw.swmm_heat_clear_cloud(this._h));
  }
}

/**
 * `heat.sources`: GLOBAL inlet temperature (°C) per {@link HeatSourceKind}
 * (Python `_HeatSources`). A source with no row reads the 20 °C default;
 * {@link isConfigured} tells the two apart.
 */
export class HeatSources extends EnumTable<number> {
  protected readonly _enum = HeatSourceKind as unknown as EnumObject;
  protected readonly _label = "HeatSourceKind";

  override get length(): number {
    return withInt(this._mod, (p) => this._raw.swmm_heat_source_count(this._h, p));
  }

  override [Symbol.iterator](): Iterator<number> {
    return Array.from({ length: this.length }, (_, i) => i)[Symbol.iterator]();
  }

  protected _read(code: number): number {
    return this._double(this._raw.swmm_heat_get_source_temp, code);
  }
  protected _write(code: number, tempC: number): void {
    raiseForCode(this._raw.swmm_heat_set_source_temp(this._h, code, tempC));
  }

  has(key: number | string): boolean {
    try {
      this._code(key);
      return true;
    } catch {
      return false;
    }
  }

  /** Whether the model set this source explicitly (or it takes the default). */
  isConfigured(source: number | string): boolean {
    const s = this._code(source);
    return (
      withInt(this._mod, (p) => this._raw.swmm_heat_get_source_configured(this._h, s, p)) !== 0
    );
  }

  /** Back to the 20 °C default, unconfigured; node overrides are untouched. */
  clear(source: number | string): void {
    raiseForCode(this._raw.swmm_heat_clear_source_temp(this._h, this._code(source)));
  }

  /** The temperature this source's water enters a node at: the override, else GLOBAL. */
  effective(source: number | string, node: number | string): number {
    const s = this._code(source);
    const n = resolveIndex(this._raw, this._h, "node", node);
    return withDouble(this._mod, (p) =>
      this._raw.swmm_heat_get_effective_source_temp(this._h, s, n, p),
    );
  }
}

/** `heat.sediment`: `[SEDIMENT_EXCHANGE]` keyed by {@link HeatSedimentParam} (Python `_HeatSediment`). */
export class HeatSediment extends EnumTable<number> {
  protected readonly _enum = HeatSedimentParam as unknown as EnumObject;
  protected readonly _label = "HeatSedimentParam";
  protected _read(code: number): number {
    return this._double(this._raw.swmm_heat_get_sediment, code);
  }
  protected _write(code: number, value: number): void {
    raiseForCode(this._raw.swmm_heat_set_sediment(this._h, code, value));
  }

  /** Whether GLOBAL GROUND_SOURCE was authored explicitly (PRESCRIBED included). */
  get groundSourceConfigured(): boolean {
    return (
      withInt(this._mod, (p) => this._raw.swmm_heat_ground_source_configured(this._h, p)) !== 0
    );
  }

  /** Restore the default PRESCRIBED channel ground selection (before a run). */
  clearGroundSource(): void {
    raiseForCode(this._raw.swmm_heat_clear_ground_source(this._h));
  }

  /** Whether GROUND_TEMPERATURE or INITIAL_TEMPERATURE was authored. */
  isConfigured(key: number | string): boolean {
    const p0 = this._code(key);
    return (
      withInt(this._mod, (p) =>
        this._raw.swmm_heat_sediment_temperature_configured(this._h, p0, p),
      ) !== 0
    );
  }

  /** Restore temperature inheritance (ground reset also clears its series). */
  clear(key: number | string): void {
    raiseForCode(this._raw.swmm_heat_clear_sediment_temperature(this._h, this._code(key)));
  }

  /** Time series driving the ground temperature (`""` for the constant). */
  get groundTimeseries(): string {
    return withCString(this._mod, 256, (buf, len) =>
      this._raw.swmm_heat_get_sediment_ground_timeseries(this._h, buf, len),
    );
  }
  set groundTimeseries(name: string | null) {
    raiseForCode(this._raw.swmm_heat_set_sediment_ground_timeseries(this._h, name ?? ""));
  }
}

/** One `[HEAT_SOURCES]` NODE override (DWF and EXTERNAL_INFLOW only). */
export interface HeatNodeOverride {
  readonly source: HeatSourceKind;
  readonly nodeIndex: number;
  readonly tempC: number;
}

/** `heat.nodeOverrides`: NODE-scope rows by position (Python `_HeatNodeOverrides`). */
export class HeatNodeOverrides extends SolverView {
  get length(): number {
    return withInt(this._mod, (p) => this._raw.swmm_heat_node_override_count(this._h, p));
  }

  *[Symbol.iterator](): Iterator<HeatNodeOverride> {
    const n = this.length;
    for (let i = 0; i < n; i++) yield this.get(i);
  }

  get(rowIndex: number): HeatNodeOverride {
    const n = this.length;
    const i = rowIndex < 0 ? rowIndex + n : rowIndex;
    if (!(i >= 0 && i < n)) throw new RangeError(String(rowIndex));
    const mod = this._mod;
    const p = checkedAlloc(mod, 16);
    try {
      mod.HEAP32[p >> 2] = 0;
      mod.HEAP32[(p + 4) >> 2] = -1;
      mod.HEAPF64[(p + 8) >> 3] = 0;
      raiseForCode(this._raw.swmm_heat_get_node_override(this._h, i, p, p + 4, p + 8));
      return {
        source: mod.HEAP32[p >> 2] as HeatSourceKind,
        nodeIndex: mod.HEAP32[(p + 4) >> 2],
        tempC: mod.HEAPF64[(p + 8) >> 3],
      };
    } finally {
      mod._free(p);
    }
  }

  /** Add or update the override of `(source, node)`; temperatures in [-50, 100] °C. */
  set(source: number | string, node: number | string, tempC: number): void {
    const s = member(HeatSourceKind as unknown as EnumObject, "HeatSourceKind", source);
    const n = resolveIndex(this._raw, this._h, "node", node);
    raiseForCode(this._raw.swmm_heat_set_node_override(this._h, s, n, tempC));
    this._solver._bumpGeneration();
  }

  /** Remove one row by index; later rows shift down. */
  remove(rowIndex: number): void {
    raiseForCode(this._raw.swmm_heat_remove_node_override(this._h, rowIndex));
    this._solver._bumpGeneration();
  }
}

/** One per-element heat attribute override; CELL2D names are one-based file ids. */
export interface HeatElementOverride {
  readonly attr: HeatAttr;
  readonly scope: HeatOverrideScope;
  readonly name: string;
  readonly value: number;
}

/** `heat.elementOverrides`: radiative and sediment attribute overrides (Python `_HeatElementOverrides`). */
export class HeatElementOverrides extends SolverView {
  get length(): number {
    return withInt(this._mod, (p) => this._raw.swmm_heat_element_override_count(this._h, p));
  }

  *[Symbol.iterator](): Iterator<HeatElementOverride> {
    const n = this.length;
    for (let i = 0; i < n; i++) yield this.get(i);
  }

  get(rowIndex: number): HeatElementOverride {
    const n = this.length;
    const i = rowIndex < 0 ? rowIndex + n : rowIndex;
    if (!(i >= 0 && i < n)) throw new RangeError(String(rowIndex));
    const mod = this._mod;
    const p = checkedAlloc(mod, 16);
    try {
      mod.HEAPU8.fill(0, p, p + 16);
      const [name] = withCStrings(mod, 256, 1, ([buf], len) =>
        this._raw.swmm_heat_get_element_override(this._h, i, p, p + 4, buf, len, p + 8),
      );
      return {
        attr: mod.HEAP32[p >> 2] as HeatAttr,
        scope: mod.HEAP32[(p + 4) >> 2] as HeatOverrideScope,
        name,
        value: mod.HEAPF64[(p + 8) >> 3],
      };
    } finally {
      mod._free(p);
    }
  }

  /**
   * Add or update the override of `(attr, scope, name)`. Sediment attributes
   * take LINK or TAG scope only; an unknown element or tag is refused.
   */
  set(attr: number | string, scope: number | string, name: string, value: number): void {
    const a = member(HeatAttr as unknown as EnumObject, "HeatAttr", attr);
    const s = member(HeatOverrideScope as unknown as EnumObject, "HeatOverrideScope", scope);
    raiseForCode(this._raw.swmm_heat_set_element_override(this._h, a, s, name, value));
    this._solver._bumpGeneration();
  }

  /** Remove one row; later rows shift down. */
  remove(rowIndex: number): void {
    raiseForCode(this._raw.swmm_heat_remove_element_override(this._h, rowIndex));
    this._solver._bumpGeneration();
  }
}

/** LID conduction material assumptions (SI): conductivities W/m/K, density kg/m³, heat capacity J/kg/K. */
export interface HeatLidMaterial {
  readonly waterConductivity: number;
  readonly soilConductivity: number;
  readonly soilDensity: number;
  readonly soilSpecificHeat: number;
}

/** An effective element value and its origin; dynamic temperatures read NaN. */
export interface HeatElementValue {
  readonly value: number;
  /** GLOBAL 0, TAG 1, NODE 2, LINK 3, air 4, series 5, CELL2D 6, MESH_TAG 7. */
  readonly source: number;
  readonly sourceName: string;
}

/** One channel-to-soil contact (zero-based indices, chainage fractions, SI invert). */
export interface ChannelGroundContact {
  link: number;
  cell: number;
  layer: number;
  beginFraction: number;
  endFraction: number;
  share: number;
  invertM: number;
}

/** {@link Heat.previewChannelGroundMap} result; counts describe the full mapping. */
export interface ChannelGroundPreview {
  link: number;
  valid: boolean;
  contactCells: number;
  contactIntervals: number;
  lengthM: number;
  coveredLengthM: number;
  uncoveredLengthM: number;
  reason: string;
  required: number;
  first: number;
  contacts: ChannelGroundContact[];
}

const camelKey = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Read a status struct (its `struct_size` set first) as a camelCase record; ints in `flags` become booleans. */
function readStatus(
  solver: Solver,
  name: "SWMM_Heat2DStatus" | "SWMM_GroundHeatStatus" | "SWMM_ChannelGroundStatus",
  flags: readonly string[],
  call: (h: number, p: number) => number,
): Record<string, number | boolean | string> {
  const mod = solver.module;
  return withStruct(
    mod,
    name,
    (p) => {
      raiseForCode(call(solver.handle, p));
      const r = readStruct(mod, name, p) as Record<string, number | string>;
      const out: Record<string, number | boolean | string> = {};
      for (const [k, v] of Object.entries(r)) {
        if (k === "struct_size") continue;
        out[camelKey(k)] = flags.includes(k) ? v !== 0 : v;
      }
      return out;
    },
    { struct_size: STRUCTS[name].size },
  );
}

function contactOf(r: Record<string, number>): ChannelGroundContact {
  return {
    link: r.link,
    cell: r.cell,
    layer: r.layer,
    beginFraction: r.begin_fraction,
    endFraction: r.end_fraction,
    share: r.share,
    invertM: r.invert_m,
  };
}

/**
 * A pre-run heat (or, with `complete`, whole hydrothermal) configuration
 * memento. Lifecycle and structural edits invalidate it; restore may be
 * repeated. Close it, or use `using`.
 */
export class HeatSnapshot {
  private _snapshot: number;
  private _owner: Solver | null;
  private _generation: number;
  private readonly _complete: boolean;
  private readonly _raw: RawApi;

  constructor(solver: Solver, { complete = false }: { complete?: boolean } = {}) {
    const h = solver.handle;
    this._raw = rawOf(solver.module);
    const state = solver.state;
    if (state !== EngineState.OPENED && state !== EngineState.BUILDING) {
      raiseForCode(ErrorCode.LIFECYCLE);
    }
    this._owner = solver;
    this._generation = solver.generation;
    this._complete = complete;
    this._snapshot = complete
      ? this._raw.swmm_config_snapshot_create(h)
      : this._raw.swmm_heat_snapshot_create(h);
    if (!this._snapshot) throw new Error("Cannot capture heat configuration");
  }

  /** Restore the captured settings, refusing a stale snapshot. */
  restore(): void {
    if (!this._snapshot || !this._owner) throw new RangeError("HeatSnapshot is closed");
    if (this._generation !== this._owner.generation) {
      throw new StaleObjectError("HeatSnapshot was invalidated by a lifecycle or structural edit");
    }
    const h = this._owner.handle;
    raiseForCode(
      this._complete
        ? this._raw.swmm_config_snapshot_restore(h, this._snapshot)
        : this._raw.swmm_heat_snapshot_restore(h, this._snapshot),
    );
    this._owner._bumpGeneration();
    this._generation = this._owner.generation;
  }

  /** Release the memento (safe after the solver is destroyed). */
  close(): void {
    if (this._snapshot) {
      if (this._complete) this._raw.swmm_config_snapshot_destroy(this._snapshot);
      else this._raw.swmm_heat_snapshot_destroy(this._snapshot);
      this._snapshot = 0;
    }
    this._owner = null;
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

/** `solver.heat`: heat-transport configuration. */
export class Heat extends SolverView {
  private _modules?: HeatModules;
  private _radiative?: HeatRadiative;
  private _solar?: HeatSolar;
  private _cloud?: HeatCloud;
  private _sources?: HeatSources;
  private _nodeOverrides?: HeatNodeOverrides;
  private _sediment?: HeatSediment;
  private _elementOverrides?: HeatElementOverrides;

  /** Whether `[OPTIONS] HEAT_TRANSPORT` is on. */
  get enabled(): boolean {
    return withInt(this._mod, (p) => this._raw.swmm_heat_get_enabled(this._h, p)) !== 0;
  }

  get modules(): HeatModules {
    return (this._modules ??= new HeatModules(this._solver));
  }

  get radiative(): HeatRadiative {
    return (this._radiative ??= new HeatRadiative(this._solver));
  }

  get solar(): HeatSolar {
    return (this._solar ??= new HeatSolar(this._solver));
  }

  get cloud(): HeatCloud {
    return (this._cloud ??= new HeatCloud(this._solver));
  }

  get sources(): HeatSources {
    return (this._sources ??= new HeatSources(this._solver));
  }

  get nodeOverrides(): HeatNodeOverrides {
    return (this._nodeOverrides ??= new HeatNodeOverrides(this._solver));
  }

  get sediment(): HeatSediment {
    return (this._sediment ??= new HeatSediment(this._solver));
  }

  get elementOverrides(): HeatElementOverrides {
    return (this._elementOverrides ??= new HeatElementOverrides(this._solver));
  }

  /**
   * Where incoming shortwave comes from. Exactly one mode is read; switching
   * keeps the other modes' settings. COMPUTED needs {@link solarSited};
   * TIMESERIES needs a bound series.
   */
  get shortwaveMode(): HeatShortwaveMode {
    return withInt(this._mod, (p) => this._raw.swmm_heat_get_shortwave_mode(this._h, p));
  }
  set shortwaveMode(value: HeatShortwaveMode | number | string) {
    const mode = member(HeatShortwaveMode as unknown as EnumObject, "HeatShortwaveMode", value);
    raiseForCode(this._raw.swmm_heat_set_shortwave_mode(this._h, mode));
  }

  /** The bound shortwave time series (`""` when none). */
  get shortwaveTimeseries(): string {
    return withCString(this._mod, 256, (buf, len) =>
      this._raw.swmm_heat_get_shortwave_timeseries(this._h, buf, len),
    );
  }

  /** Bind a `[TIMESERIES]` as the shortwave record (switches to TIMESERIES mode). */
  setShortwaveTimeseries(name: string): void {
    raiseForCode(this._raw.swmm_heat_set_shortwave_timeseries(this._h, name));
  }

  /** Resolved incoming shortwave at the current step, W/m², cloud applied. */
  get currentShortwave(): number {
    return withDouble(this._mod, (p) => this._raw.swmm_heat_get_current_shortwave(this._h, p));
  }

  /** Whether latitude and longitude were both set explicitly (needed by COMPUTED). */
  get solarSited(): boolean {
    return withInt(this._mod, (p) => this._raw.swmm_heat_get_solar_sited(this._h, p)) !== 0;
  }

  /** Dry-element temperature policy: HOLD 0, AIR 1, DEFAULT 2. */
  get dryPolicy(): number {
    return withInt(this._mod, (p) => this._raw.swmm_heat_get_dry_policy(this._h, p));
  }
  set dryPolicy(policy: number) {
    raiseForCode(this._raw.swmm_heat_set_dry_policy(this._h, policy));
  }

  /** LID conduction material assumptions (SI). */
  get lidMaterial(): HeatLidMaterial {
    const mod = this._mod;
    const p = checkedAlloc(mod, 32);
    try {
      mod.HEAPF64.fill(0, p >> 3, (p >> 3) + 4);
      raiseForCode(this._raw.swmm_heat_get_lid_material(this._h, p));
      const f = mod.HEAPF64;
      return {
        waterConductivity: f[p >> 3],
        soilConductivity: f[(p >> 3) + 1],
        soilDensity: f[(p >> 3) + 2],
        soilSpecificHeat: f[(p >> 3) + 3],
      };
    } finally {
      mod._free(p);
    }
  }

  /** Provenance bits: configured 1, shared site 2, explicit lat/lon/timezone/elevation 4/8/16/32. */
  get authoringFlags(): number {
    const mod = this._mod;
    const p = checkedAlloc(mod, 4);
    try {
      mod.HEAPU32[p >> 2] = 0;
      raiseForCode(this._raw.swmm_heat_get_authoring_flags(this._h, p));
      return mod.HEAPU32[p >> 2];
    } finally {
      mod._free(p);
    }
  }

  /** The NODE/LINK/CELL2D precedence value of an attribute and its origin. */
  effectiveElement(attr: number | string, scope: number | string, name: string): HeatElementValue {
    const a = member(HeatAttr as unknown as EnumObject, "HeatAttr", attr);
    const s = member(HeatOverrideScope as unknown as EnumObject, "HeatOverrideScope", scope);
    if (name.includes("\0")) throw new RangeError("Element name contains a null byte");
    const mod = this._mod;
    const p = checkedAlloc(mod, 16);
    try {
      mod.HEAPU8.fill(0, p, p + 16);
      const [sourceName] = withCStrings(mod, 256, 1, ([buf], len) =>
        this._raw.swmm_heat_get_effective_element(this._h, a, s, name, p, p + 8, buf, len),
      );
      return { value: mod.HEAPF64[p >> 3], source: mod.HEAP32[(p + 8) >> 2], sourceName };
    } finally {
      mod._free(p);
    }
  }

  /** Requested and initialized mesh heat, active modules and the capability reason. */
  get meshStatus(): Record<string, number | boolean | string> {
    return readStatus(
      this._solver,
      "SWMM_Heat2DStatus",
      [
        "requested",
        "initialized",
        "surface_active",
        "radiative_active",
        "bed_active",
        "experimental",
      ],
      this._raw.swmm_heat_get_2d_status,
    );
  }

  /** @internal Read `count` doubles from a range call. */
  private _range(count: number, call: (p: number) => number): number[] {
    if (count < 0) throw new RangeError("count must be nonnegative");
    const mod = this._mod;
    const p = checkedAlloc(mod, Math.max(8 * count, 8));
    try {
      raiseForCode(call(count ? p : 0));
      return Array.from(new Float64Array(mod.HEAPU8.buffer, p, count));
    } finally {
      mod._free(p);
    }
  }

  /** A contiguous range of mesh cells' heat values, SI (kinds as `SWMM_Heat2DValue`). */
  meshValues(kind: number, firstCell: number, count: number): number[] {
    return this._range(count, (p) =>
      this._raw.swmm_heat_get_2d_values(this._h, kind, firstCell, count, p),
    );
  }

  /** Requested and measured soil heat, owner counts and the capability reason. */
  groundStatus(): Record<string, number | boolean | string> {
    return readStatus(
      this._solver,
      "SWMM_GroundHeatStatus",
      ["requested", "initialized", "conduction_active", "lateral_active", "experimental"],
      this._raw.swmm_heat_get_ground_status,
    );
  }

  /** Soil heat values over mesh cells (kinds as `SWMM_GroundHeatValue`); unmodeled cells NaN. */
  groundValues(kind: number, firstCell: number, count: number): number[] {
    return this._range(count, (p) =>
      this._raw.swmm_heat_get_ground_values(this._h, kind, firstCell, count, p),
    );
  }

  /** Fixed depth layers of one cell (kinds 0..7). */
  groundLayers(cell: number, kind: number, firstLayer: number, count: number): number[] {
    return this._range(count, (p) =>
      this._raw.swmm_heat_get_ground_layers(this._h, cell, kind, firstLayer, count, p),
    );
  }

  /** Requested channel ground choice and measured mapping/activity counts. */
  channelGroundStatus(): Record<string, number | boolean | string> {
    return readStatus(
      this._solver,
      "SWMM_ChannelGroundStatus",
      ["requested", "initialized", "exchange_active", "experimental"],
      this._raw.swmm_heat_get_channel_ground_status,
    );
  }

  /** Mapped channel fields over links (kinds 0..4); unmapped links NaN. */
  channelGroundValues(kind: number, firstLink: number, count: number): number[] {
    return this._range(count, (p) =>
      this._raw.swmm_heat_get_channel_ground_values(this._h, kind, firstLink, count, p),
    );
  }

  /** One initialized channel-to-soil contact. */
  channelGroundContact(index: number): ChannelGroundContact {
    return withStruct(
      this._mod,
      "SWMM_ChannelGroundContact",
      (p) => {
        raiseForCode(this._raw.swmm_heat_get_channel_ground_contact(this._h, index, p));
        return contactOf(
          readStruct(this._mod, "SWMM_ChannelGroundContact", p) as Record<string, number>,
        );
      },
      { struct_size: STRUCTS.SWMM_ChannelGroundContact.size },
    );
  }

  /**
   * Pre-run XY coverage of a link (does not initialize heat). Leave `first`
   * out for every contact, or page with `first` and `limit`. `progress(stage,
   * percent)` may return true to cancel (stage 1 mesh, 2 mapping); its
   * errors are rethrown after the native call.
   */
  previewChannelGroundMap(
    link: number | string,
    {
      first = null,
      limit = 256,
      progress = null,
    }: {
      first?: number | null;
      limit?: number;
      progress?: ((stage: number, percent: number) => boolean | void) | null;
    } = {},
  ): ChannelGroundPreview {
    if (progress !== null && typeof progress !== "function") {
      throw new TypeError("progress must be callable");
    }
    const mod = this._mod;
    const h = this._h;
    const li = resolveIndex(this._raw, h, "link", link);
    const offset = first === null ? 0 : first;
    let capacity = first === null ? 0 : limit;
    if (offset < 0 || capacity < 0) throw new RangeError("first and limit must be nonnegative");
    let error: unknown = undefined;
    const slot = progress
      ? mod.addFunction((_e: number, stage: number, percent: number) => {
          try {
            return progress(stage, percent) ? 1 : 0;
          } catch (err) {
            error = err;
            return 1;
          }
        }, CALLBACK_SIGNATURES.SWMM_CancelCallback)
      : 0;
    const contactSize = STRUCTS.SWMM_ChannelGroundContact.size;
    const required = checkedAlloc(mod, 4);
    let contacts = 0;
    try {
      return withStruct(
        mod,
        "SWMM_ChannelGroundPreview",
        (pp) => {
          const call = (cp: number, cap: number) =>
            first !== null
              ? this._raw.swmm_heat_preview_channel_ground_map_page(
                  h,
                  li,
                  pp,
                  offset,
                  cp,
                  cap,
                  required,
                  slot,
                  0,
                )
              : slot
                ? this._raw.swmm_heat_preview_channel_ground_map_with_progress(
                    h,
                    li,
                    pp,
                    cp,
                    cap,
                    required,
                    slot,
                    0,
                  )
                : this._raw.swmm_heat_preview_channel_ground_map(h, li, pp, cp, cap, required);
          mod.HEAP32[required >> 2] = 0;
          if (first === null) {
            const rc = this._solver._operation(() => call(0, 0));
            if (error !== undefined) throw error;
            raiseForCode(rc);
            capacity = mod.HEAP32[required >> 2];
          }
          contacts = checkedAlloc(mod, Math.max(contactSize * capacity, contactSize));
          mod.HEAPU8.fill(0, contacts, contacts + contactSize * Math.max(capacity, 1));
          const rc = this._solver._operation(() => call(contacts, capacity));
          if (error !== undefined) throw error;
          raiseForCode(rc);
          const total = mod.HEAP32[required >> 2];
          const copied = Math.max(0, Math.min(capacity, total - offset));
          const r = readStruct(mod, "SWMM_ChannelGroundPreview", pp) as Record<
            string,
            number | string
          >;
          return {
            link: r.link as number,
            valid: r.valid !== 0,
            contactCells: r.contact_cells as number,
            contactIntervals: r.contact_intervals as number,
            lengthM: r.length_m as number,
            coveredLengthM: r.covered_length_m as number,
            uncoveredLengthM: r.uncovered_length_m as number,
            reason: r.reason as string,
            required: total,
            first: offset,
            contacts: Array.from({ length: copied }, (_, i) =>
              contactOf(
                readStruct(mod, "SWMM_ChannelGroundContact", contacts + i * contactSize) as Record<
                  string,
                  number
                >,
              ),
            ),
          };
        },
        { struct_size: STRUCTS.SWMM_ChannelGroundPreview.size },
      );
    } finally {
      if (contacts) mod._free(contacts);
      mod._free(required);
      if (slot) mod.removeFunction(slot);
    }
  }

  /** Capture pre-run settings; `complete` also captures climate, snow and registrations. */
  snapshot({ complete = false }: { complete?: boolean } = {}): HeatSnapshot {
    return new HeatSnapshot(this._solver, { complete });
  }

  /**
   * Apply `callback(solver)` before initialization, rolled back on any
   * error (which is rethrown after the native rollback). Only climate, snow,
   * heat, HEAT_TRANSPORT, component registrations and climate-file paths
   * may change. Returns the callback's result.
   */
  editAtomic<T>(callback: (solver: Solver) => T): T {
    if (typeof callback !== "function") throw new TypeError("callback must be callable");
    const mod = this._mod;
    const solver = this._solver;
    let error: unknown = undefined;
    let result: T | undefined;
    const slot = mod.addFunction(() => {
      try {
        result = callback(solver);
        return 0;
      } catch (err) {
        error = err;
        return ErrorCode.BADPARAM;
      }
    }, CALLBACK_SIGNATURES.SWMM_HydrothermalEdit);
    let rc: number;
    try {
      const h = this._h;
      rc = solver._operation(() => this._raw.swmm_hydrothermal_edit_atomic(h, slot, 0));
    } finally {
      mod.removeFunction(slot);
    }
    solver._bumpGeneration();
    if (error !== undefined) throw error;
    raiseForCode(rc);
    return result as T;
  }
}
