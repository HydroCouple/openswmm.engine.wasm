/**
 * @file Snow.ts
 * @brief Snow configuration and accepted state (Python `openswmm.engine._snow`).
 *
 * `solver.snow`: the snow model (degree-day or UEB), UEB options and packs,
 * radiation and cloud configuration, per-subcatchment snow state and the UEB
 * ledger. New process quantities are SI; unavailable UEB quantities are NaN.
 * Records are plain objects keyed by the C field names (`swe_m`,
 * `forest_fraction`, ...), as in Python's dictionaries.
 *
 * @license  Apache-2.0
 */

import { ErrorCode } from "./enums.js";
import { BadParamError, ElementNotFoundError, StaleObjectError, raiseForCode } from "./errors.js";
import { checkedAlloc, guardedRaw, withDouble, withInt } from "./mem.js";
import type { RawApi } from "./raw.js";
import type { Solver } from "./Solver.js";
import { readStruct, withStruct, withStructs, type StructValue } from "./structs.js";
import type { OpenSwmmWasmModule } from "./types.js";

/** A snow record (pack, state, ledger, radiation, cloud, meteorology summary). */
export type SnowRecord = Record<string, number | string | number[]>;

/** One row of {@link Snow.applyPacks}: legacy arrays in INP units, `ueb` in SI. */
export interface SnowpackRow {
  name: string;
  /** 3 surfaces (plowable, impervious, pervious) × 7 legacy parameters. */
  surface: number[][];
  /** The 6 legacy removal parameters. */
  removal: number[];
  removal_subcatch?: string;
  ueb: Record<string, number>;
}

const DIAGNOSTIC = 4096;

/** `solver.snow`. */
export class Snow {
  /** @internal */
  private readonly _mod: OpenSwmmWasmModule;
  /** @internal */
  private readonly _raw: RawApi;
  /** @internal */
  private readonly _generation: number;

  /** @param owner The solver whose snow configuration this edits. */
  constructor(private readonly _owner: Solver) {
    this._mod = _owner.module;
    this._raw = guardedRaw(this._mod, () => void _owner.handle);
    this._generation = _owner.generation;
  }

  /** @internal Engine handle, refusing a view from an older model generation. */
  private get _h(): number {
    if (this._generation !== this._owner.generation) {
      throw new StaleObjectError("Snow view was invalidated; reacquire it from the solver");
    }
    return this._owner.handle;
  }

  /** @internal Read text through a getter that refuses short buffers with BUFSIZE. */
  private _text(read: (buf: number, capacity: number) => number): string {
    for (let capacity = 256; ; capacity *= 2) {
      const buf = checkedAlloc(this._mod, capacity);
      try {
        this._mod.HEAPU8[buf] = 0;
        const rc = read(buf, capacity);
        if (rc === ErrorCode.BUFSIZE) continue;
        raiseForCode(rc);
        return this._mod.UTF8ToString(buf, capacity);
      } finally {
        this._mod._free(buf);
      }
    }
  }

  /** @internal Run a call with a diagnostic buffer; a failure with a message is a BadParamError. */
  private _diagnosed(call: (diagnostic: number, capacity: number) => number): void {
    const buf = checkedAlloc(this._mod, DIAGNOSTIC);
    try {
      this._mod.HEAPU8[buf] = 0;
      const rc = call(buf, DIAGNOSTIC);
      if (rc) {
        const message = this._mod.UTF8ToString(buf, DIAGNOSTIC);
        if (message) throw new BadParamError(message);
        raiseForCode(rc);
      }
    } finally {
      this._mod._free(buf);
    }
  }

  /** `"UEB"` or `"DEGREE_DAY"`. */
  get model(): "UEB" | "DEGREE_DAY" {
    return withInt(this._mod, (p) => this._raw.swmm_snow_get_model(this._h, p)) === 1
      ? "UEB"
      : "DEGREE_DAY";
  }
  set model(value: "UEB" | "DEGREE_DAY") {
    const code = { UEB: 1, DEGREE_DAY: 0 }[String(value).toUpperCase()];
    if (code === undefined) throw new BadParamError("Snow model must be UEB or DEGREE_DAY");
    raiseForCode(this._raw.swmm_snow_set_model(this._h, code));
  }

  /** Snow process time step in seconds. */
  get stepSeconds(): number {
    return withDouble(this._mod, (p) => this._raw.swmm_snow_get_step(this._h, p));
  }
  set stepSeconds(value: number) {
    raiseForCode(this._raw.swmm_snow_set_step(this._h, value));
  }

  /** A UEB option (`[UEB_OPTIONS]` key) as text. */
  option(key: string): string {
    return this._text((buf, cap) => this._raw.swmm_ueb_option_get(this._h, key, buf, cap));
  }

  /** Set a UEB option. */
  setOption(key: string, value: string | number): void {
    raiseForCode(this._raw.swmm_ueb_option_set(this._h, key, String(value)));
  }

  /** The twelve monthly air-temperature ranges, in Celsius. */
  get monthlyRanges(): number[] {
    const p = checkedAlloc(this._mod, 96);
    try {
      raiseForCode(this._raw.swmm_ueb_get_monthly_ranges(this._h, p));
      return Array.from(this._mod.HEAPF64.subarray(p >> 3, (p >> 3) + 12));
    } finally {
      this._mod._free(p);
    }
  }
  set monthlyRanges(values: number[]) {
    const rows = Array.from(values);
    if (rows.length !== 12) throw new BadParamError("Expected twelve monthly ranges in Celsius");
    const p = checkedAlloc(this._mod, 96);
    try {
      this._mod.HEAPF64.set(rows, p >> 3);
      raiseForCode(this._raw.swmm_ueb_set_monthly_ranges(this._h, p));
    } finally {
      this._mod._free(p);
    }
  }

  /** @internal */
  private _packIndex(name: string): number {
    const i = this._raw.swmm_snowpack_index(this._h, name);
    if (i < 0) throw new ElementNotFoundError(name);
    return i;
  }

  /** UEB parameters of a named snowpack (`model`, `forest_fraction`, ...). */
  pack(name: string): SnowRecord {
    const i = this._packIndex(name);
    return withStruct(this._mod, "SWMM_UebSnowpack", (p) => {
      raiseForCode(this._raw.swmm_snowpack_get_ueb(this._h, i, p));
      return readStruct(this._mod, "SWMM_UebSnowpack", p) as SnowRecord;
    });
  }

  /** Change some UEB parameters of a named snowpack; the rest keep their values. */
  setPack(name: string, changes: Record<string, number>): void {
    const current = this.pack(name);
    const unknown = Object.keys(changes).filter((k) => !(k in current));
    if (unknown.length)
      throw new BadParamError(`Unknown snowpack fields: ${unknown.sort().join(", ")}`);
    const i = this._packIndex(name);
    withStruct(
      this._mod,
      "SWMM_UebSnowpack",
      (p) => raiseForCode(this._raw.swmm_snowpack_set_ueb(this._h, i, p)),
      { ...current, ...changes } as StructValue,
    );
  }

  /** Accepted snow state of a subcatchment surface (0 plowable, 1 impervious, 2 pervious). */
  state(subcatch: number | string, surface = 2): SnowRecord {
    const h = this._h;
    const i = typeof subcatch === "string" ? this._raw.swmm_subcatch_index(h, subcatch) : subcatch;
    if (i < 0) throw new ElementNotFoundError(subcatch);
    return withStruct(this._mod, "SWMM_SnowState", (p) => {
      raiseForCode(this._raw.swmm_subcatch_get_snow_process_state(h, i, surface, p));
      return readStruct(this._mod, "SWMM_SnowState", p) as SnowRecord;
    });
  }

  /** The UEB water and energy ledger (m³, kJ). */
  ledger(): SnowRecord {
    return withStruct(this._mod, "SWMM_SnowLedger", (p) => {
      raiseForCode(this._raw.swmm_snow_get_ueb_ledger(this._h, p));
      return readStruct(this._mod, "SWMM_SnowLedger", p) as SnowRecord;
    });
  }

  /**
   * Replace the snow/radiation TEMPERATURE keys and the UEB_OPTIONS at once;
   * omitted keys take their defaults. `cloud` (a complete record, as
   * {@link cloud} returns) also replaces the shared cloud record.
   * @throws BadParamError with the engine's diagnostic when the rows are invalid.
   */
  applyConfiguration(
    temperatureRows = "",
    uebRows = "",
    { cloud }: { cloud?: SnowRecord } = {},
  ): void {
    if (!cloud) {
      this._diagnosed((d, cap) =>
        this._raw.swmm_snow_apply_configuration(this._h, temperatureRows, uebRows, d, cap),
      );
      return;
    }
    const { series = "", ...record } = cloud;
    withStruct(
      this._mod,
      "SWMM_ClimateCloudConfig",
      (p) =>
        this._diagnosed((d, cap) =>
          this._raw.swmm_snow_apply_configuration_with_cloud(
            this._h,
            temperatureRows,
            uebRows,
            p,
            String(series),
            d,
            cap,
          ),
        ),
      record as StructValue,
    );
  }

  /** Site and shortwave/longwave radiation configuration. */
  get radiation(): SnowRecord {
    return withStruct(this._mod, "SWMM_RadiationConfig", (p) => {
      raiseForCode(this._raw.swmm_climate_get_radiation(this._h, p));
      return readStruct(this._mod, "SWMM_RadiationConfig", p) as SnowRecord;
    });
  }
  set radiation(values: SnowRecord) {
    withStruct(
      this._mod,
      "SWMM_RadiationConfig",
      (p) => raiseForCode(this._raw.swmm_climate_set_radiation(this._h, p)),
      values as StructValue,
    );
  }

  /** Source of one radiation channel (a series or file name). */
  radiationSource(channel: number): string {
    return this._text((buf, cap) =>
      this._raw.swmm_climate_get_radiation_source(this._h, channel, buf, cap),
    );
  }

  /** Set the source of one radiation channel. */
  setRadiationSource(channel: number, value: string): void {
    raiseForCode(this._raw.swmm_climate_set_radiation_source(this._h, channel, value));
  }

  /** The shared cloud record, with its `series`. */
  get cloud(): SnowRecord {
    return withStruct(this._mod, "SWMM_ClimateCloudConfig", (p) => {
      const series = this._text((buf, cap) =>
        this._raw.swmm_climate_get_cloud(this._h, p, buf, cap),
      );
      return { ...(readStruct(this._mod, "SWMM_ClimateCloudConfig", p) as SnowRecord), series };
    });
  }

  /** Summarize a meteorology file without loading it: records, dates, minima and maxima. */
  previewMeteorology(path: string): SnowRecord {
    return withStruct(this._mod, "SWMM_ClimateMetSummary", (p) => {
      this._diagnosed((d, cap) =>
        this._raw.swmm_climate_preview_meteorology(this._h, path, p, d, cap),
      );
      return readStruct(this._mod, "SWMM_ClimateMetSummary", p) as SnowRecord;
    });
  }

  /**
   * Add or replace named snowpacks at once. Snowpacks and assignments not
   * named are kept. A successful edit invalidates existing views.
   */
  applyPacks(rows: Iterable<SnowpackRow>): void {
    const edits = Array.from(rows, (row) => {
      const surface = Array.from(row.surface, (s) => Array.from(s));
      const removal = Array.from(row.removal);
      if (surface.length !== 3 || surface.some((s) => s.length !== 7) || removal.length !== 6) {
        throw new BadParamError("surface must be 3x7 and removal must have six values");
      }
      return {
        name: row.name,
        surface: surface.flat(),
        removal,
        removal_subcatch: row.removal_subcatch ?? "",
        ueb: row.ueb,
      } as StructValue;
    });
    withStructs(this._mod, "SWMM_SnowpackEdit", edits, (p) =>
      this._diagnosed((d, cap) =>
        this._raw.swmm_snowpack_apply(this._h, edits.length ? p : 0, edits.length, d, cap),
      ),
    );
    if (edits.length) this._owner._bumpGeneration();
  }
}
