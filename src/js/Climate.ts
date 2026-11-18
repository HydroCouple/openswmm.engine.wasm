/**
 * @file Climate.ts
 * @brief `solver.climate`: temperature, evaporation, wind, humidity, snowmelt,
 *        areal depletion and monthly adjustments (Python
 *        `openswmm.engine._climate`).
 *
 * Monthly arrays have 12 values (January first); areal depletion curves 10.
 *
 * @license  Apache-2.0
 */

import { STRUCTS } from "./raw.js";
import { BadParamError, raiseForCode } from "./errors.js";
import { datetimeToOadate } from "./dates.js";
import { checkedAlloc, withCString, withDouble, withInt } from "./mem.js";
import { readStruct, withStruct, type StructValue } from "./structs.js";
import { SolverView } from "./view.js";

type IntGet = (h: number, out: number) => number;
type IntSet = (h: number, v: number) => number;
type TextGet = (h: number, buf: number, len: number) => number;
type TextSet = (h: number, v: string | null) => number;
type ArrayIO = (h: number, values: number, count: number) => number;

/** One sample of {@link Climate.previewEvaporation}. */
export interface EvapPreviewSample {
  date: number;
  source_rate: number;
  adjustment: number;
  effective_rate: number;
  status: number;
}

/** Result of {@link Climate.previewEvaporation}. */
export interface EvapPreview {
  samples: EvapPreviewSample[];
  summary: Record<string, number | boolean>;
  diagnostic: string;
}

const PREVIEW_FIELDS = new Set([
  "evap_type",
  "evap_monthly",
  "pan_coeff",
  "adjust_evaporation",
  "evap_timeseries",
  "temp_source",
  "temp_timeseries",
  "climate_file_path",
  "climate_file_start",
  "climate_file_temp_units",
  "latitude",
  "longitude_correction_minutes",
  "adjust_temperature",
]);

/** `solver.climate`. */
export class Climate extends SolverView {
  /** @internal */
  private _i(get: IntGet): number {
    return withInt(this._mod, (p) => get(this._h, p));
  }
  /** @internal */
  private _d(get: IntGet): number {
    return withDouble(this._mod, (p) => get(this._h, p));
  }
  /** @internal */
  private _set(set: IntSet, v: number): void {
    raiseForCode(set(this._h, v));
  }
  /** @internal */
  private _s(get: TextGet): string {
    return withCString(this._mod, 256, (buf, len) => get(this._h, buf, len));
  }
  /** @internal */
  private _setS(set: TextSet, v: string): void {
    raiseForCode(set(this._h, v));
  }
  /** @internal */
  private _arr(get: ArrayIO, n: number): number[] {
    const p = checkedAlloc(this._mod, 8 * n);
    try {
      raiseForCode(get(this._h, p, n));
      return Array.from(this._mod.HEAPF64.subarray(p >> 3, (p >> 3) + n));
    } finally {
      this._mod._free(p);
    }
  }
  /** @internal */
  private _setArr(set: ArrayIO, values: ArrayLike<number>, n: number): void {
    if (values.length !== n) throw new BadParamError(`expected ${n} values, got ${values.length}`);
    const p = checkedAlloc(this._mod, 8 * n);
    try {
      this._mod.HEAPF64.set(Array.from(values), p >> 3);
      raiseForCode(set(this._h, p, n));
    } finally {
      this._mod._free(p);
    }
  }

  /** Temperature source code. */
  get tempSource(): number {
    return this._i(this._raw.swmm_climate_get_temp_source);
  }
  set tempSource(v: number) {
    this._set(this._raw.swmm_climate_set_temp_source, v);
  }
  /** Temperature time series id. */
  get tempTimeseries(): string {
    return this._s(this._raw.swmm_climate_get_temp_timeseries);
  }
  set tempTimeseries(v: string) {
    this._setS(this._raw.swmm_climate_set_temp_timeseries, v);
  }
  /** Climate-file start date (OADate). */
  get tempFileStart(): number {
    return this._d(this._raw.swmm_climate_get_temp_file_start);
  }
  set tempFileStart(v: number) {
    this._set(this._raw.swmm_climate_set_temp_file_start, v);
  }
  /** Climate-file temperature units: 0 tenths of degC, 1 degC, 2 degF, -1 the reader's default. */
  get tempUnits(): number {
    return this._i(this._raw.swmm_climate_get_temp_units);
  }
  set tempUnits(v: number) {
    this._set(this._raw.swmm_climate_set_temp_units, v);
  }
  /** Site elevation. */
  get elevation(): number {
    return this._d(this._raw.swmm_climate_get_elevation);
  }
  set elevation(v: number) {
    this._set(this._raw.swmm_climate_set_elevation, v);
  }
  /** Site latitude (degrees). */
  get latitude(): number {
    return this._d(this._raw.swmm_climate_get_latitude);
  }
  set latitude(v: number) {
    this._set(this._raw.swmm_climate_set_latitude, v);
  }
  /** Longitude correction (minutes). */
  get longitudeCorrection(): number {
    return this._d(this._raw.swmm_climate_get_longitude_correction);
  }
  set longitudeCorrection(v: number) {
    this._set(this._raw.swmm_climate_set_longitude_correction, v);
  }
  /** Evaporation source (an `EvapType` value). */
  get evapType(): number {
    return this._i(this._raw.swmm_climate_get_evap_type);
  }
  set evapType(v: number) {
    this._set(this._raw.swmm_climate_set_evap_type, v);
  }
  /** Monthly evaporation rates. */
  get evapMonthly(): number[] {
    return this._arr(this._raw.swmm_climate_get_evap_monthly, 12);
  }
  set evapMonthly(v: ArrayLike<number>) {
    this._setArr(this._raw.swmm_climate_set_evap_monthly, v, 12);
  }
  /** Evaporation time series id. */
  get evapTimeseries(): string {
    return this._s(this._raw.swmm_climate_get_evap_timeseries);
  }
  set evapTimeseries(v: string) {
    this._setS(this._raw.swmm_climate_set_evap_timeseries, v);
  }
  /** Monthly pan coefficients. */
  get panCoeff(): number[] {
    return this._arr(this._raw.swmm_climate_get_pan_coeff, 12);
  }
  set panCoeff(v: ArrayLike<number>) {
    this._setArr(this._raw.swmm_climate_set_pan_coeff, v, 12);
  }
  /** Recovery pattern id for infiltration capacity. */
  get evapRecovery(): string {
    return this._s(this._raw.swmm_climate_get_evap_recovery);
  }
  set evapRecovery(v: string) {
    this._setS(this._raw.swmm_climate_set_evap_recovery, v);
  }
  /** Wind source (0 monthly, 1 climate file). */
  get windType(): number {
    return this._i(this._raw.swmm_climate_get_wind_type);
  }
  set windType(v: number) {
    this._set(this._raw.swmm_climate_set_wind_type, v);
  }
  /** Monthly average wind speeds. */
  get windMonthly(): number[] {
    return this._arr(this._raw.swmm_climate_get_wind_monthly, 12);
  }
  set windMonthly(v: ArrayLike<number>) {
    this._setArr(this._raw.swmm_climate_set_wind_monthly, v, 12);
  }
  /** Humidity source (0 constant, 1 monthly, 2 time series). */
  get humidityType(): number {
    return this._i(this._raw.swmm_climate_get_humidity_type);
  }
  set humidityType(v: number) {
    this._set(this._raw.swmm_climate_set_humidity_type, v);
  }
  /** Humidity variable (0 relative humidity, 1 dew point). */
  get humidityVariable(): number {
    return this._i(this._raw.swmm_climate_get_humidity_variable);
  }
  set humidityVariable(v: number) {
    this._set(this._raw.swmm_climate_set_humidity_variable, v);
  }
  /** Monthly humidity values. */
  get humidityMonthly(): number[] {
    return this._arr(this._raw.swmm_climate_get_humidity_monthly, 12);
  }
  set humidityMonthly(v: ArrayLike<number>) {
    this._setArr(this._raw.swmm_climate_set_humidity_monthly, v, 12);
  }
  /** Humidity time series id. */
  get humidityTimeseries(): string {
    return this._s(this._raw.swmm_climate_get_humidity_timeseries);
  }
  set humidityTimeseries(v: string) {
    this._setS(this._raw.swmm_climate_set_humidity_timeseries, v);
  }
  /** Air temperature below which precipitation is snow. */
  get snowTemp(): number {
    return this._d(this._raw.swmm_climate_get_snow_temp);
  }
  set snowTemp(v: number) {
    this._set(this._raw.swmm_climate_set_snow_temp, v);
  }
  /** Antecedent temperature index weight. */
  get atiWeight(): number {
    return this._d(this._raw.swmm_climate_get_ati_weight);
  }
  set atiWeight(v: number) {
    this._set(this._raw.swmm_climate_set_ati_weight, v);
  }
  /** Negative melt ratio. */
  get negMeltRatio(): number {
    return this._d(this._raw.swmm_climate_get_neg_melt_ratio);
  }
  set negMeltRatio(v: number) {
    this._set(this._raw.swmm_climate_set_neg_melt_ratio, v);
  }
  /** Areal depletion curve of impervious areas (10 values). */
  get adcImpervious(): number[] {
    return this._arr(this._raw.swmm_climate_get_adc_impervious, 10);
  }
  set adcImpervious(v: ArrayLike<number>) {
    this._setArr(this._raw.swmm_climate_set_adc_impervious, v, 10);
  }
  /** Areal depletion curve of pervious areas (10 values). */
  get adcPervious(): number[] {
    return this._arr(this._raw.swmm_climate_get_adc_pervious, 10);
  }
  set adcPervious(v: ArrayLike<number>) {
    this._setArr(this._raw.swmm_climate_set_adc_pervious, v, 10);
  }
  /** Monthly temperature adjustments. */
  get adjustTemperature(): number[] {
    return this._arr(this._raw.swmm_climate_get_adjust_temperature, 12);
  }
  set adjustTemperature(v: ArrayLike<number>) {
    this._setArr(this._raw.swmm_climate_set_adjust_temperature, v, 12);
  }
  /** Monthly evaporation adjustments. */
  get adjustEvaporation(): number[] {
    return this._arr(this._raw.swmm_climate_get_adjust_evaporation, 12);
  }
  set adjustEvaporation(v: ArrayLike<number>) {
    this._setArr(this._raw.swmm_climate_set_adjust_evaporation, v, 12);
  }
  /** Monthly rainfall multipliers. */
  get adjustRainfall(): number[] {
    return this._arr(this._raw.swmm_climate_get_adjust_rainfall, 12);
  }
  set adjustRainfall(v: ArrayLike<number>) {
    this._setArr(this._raw.swmm_climate_set_adjust_rainfall, v, 12);
  }
  /** Monthly conductivity multipliers. */
  get adjustConductivity(): number[] {
    return this._arr(this._raw.swmm_climate_get_adjust_conductivity, 12);
  }
  set adjustConductivity(v: ArrayLike<number>) {
    this._setArr(this._raw.swmm_climate_set_adjust_conductivity, v, 12);
  }

  /**
   * Sample the evaporation source between `start` and `end` every
   * `intervalDays`, from the model's settings or, with `config`, from draft
   * values (any of the evaporation, temperature-source and climate-file
   * fields; the rest come from the model). Live runtime forcing is excluded.
   */
  previewEvaporation(
    start: Date | number,
    end: Date | number,
    intervalDays: number,
    { config }: { config?: Record<string, unknown> } = {},
  ): EvapPreview {
    const first = start instanceof Date ? datetimeToOadate(start) : start;
    const last = end instanceof Date ? datetimeToOadate(end) : end;
    let draft: StructValue | null = null;
    if (config) {
      const unknown = Object.keys(config).filter((k) => !PREVIEW_FIELDS.has(k));
      if (unknown.length)
        throw new BadParamError(`Unknown evaporation preview fields: ${unknown.sort().join(", ")}`);
      const pick = <T>(key: string, fallback: T): T =>
        key in config ? (config[key] as T) : fallback;
      const climateFile = withCString(this._mod, 1024, (a, len) => {
        const o = checkedAlloc(this._mod, len);
        try {
          return this._raw.swmm_file_path_get(this._h, 7, "", a, len, o, len);
        } finally {
          this._mod._free(o);
        }
      });
      const twelve = (key: string, fallback: number[]) => {
        const v = Array.from(pick<ArrayLike<number>>(key, fallback));
        if (v.length !== 12) throw new BadParamError(`${key} must contain twelve values`);
        return v;
      };
      draft = {
        evap_type: pick("evap_type", this.evapType),
        evap_monthly: twelve("evap_monthly", this.evapMonthly),
        pan_coeff: twelve("pan_coeff", this.panCoeff),
        adjust_evaporation: twelve("adjust_evaporation", this.adjustEvaporation),
        evap_timeseries: pick("evap_timeseries", this.evapTimeseries),
        temp_source: pick("temp_source", this.tempSource),
        temp_timeseries: pick("temp_timeseries", this.tempTimeseries),
        climate_file_path: pick("climate_file_path", climateFile),
        climate_file_start: pick("climate_file_start", this.tempFileStart),
        climate_file_temp_units: pick("climate_file_temp_units", this.tempUnits),
        latitude: pick("latitude", this.latitude),
        longitude_correction_minutes: pick(
          "longitude_correction_minutes",
          this.longitudeCorrection,
        ),
        adjust_temperature: twelve("adjust_temperature", this.adjustTemperature),
      };
    }
    const run = (cfg: number) =>
      withStruct(this._mod, "SWMM_EvapPreviewSummary", (summary) => {
        const diagnostic = checkedAlloc(this._mod, 4096 + 4);
        const count = diagnostic + 4096;
        try {
          const call = (samples: number, capacity: number) => {
            this._mod.HEAPU8[diagnostic] = 0;
            const rc = cfg
              ? this._raw.swmm_climate_preview_evaporation_with_config(
                  this._h,
                  cfg,
                  first,
                  last,
                  intervalDays,
                  samples,
                  capacity,
                  count,
                  summary,
                  diagnostic,
                  4096,
                )
              : this._raw.swmm_climate_preview_evaporation(
                  this._h,
                  first,
                  last,
                  intervalDays,
                  samples,
                  capacity,
                  count,
                  summary,
                  diagnostic,
                  4096,
                );
            raiseForCode(rc, this._mod.UTF8ToString(diagnostic, 4096));
          };
          call(0, 0);
          const n = this._mod.HEAP32[count >> 2];
          const size = STRUCTS.SWMM_EvapPreviewSample.size;
          const buf = checkedAlloc(this._mod, size * Math.max(n, 1));
          try {
            call(buf, n);
            const rows = Array.from(
              { length: this._mod.HEAP32[count >> 2] },
              (_, i) =>
                readStruct(
                  this._mod,
                  "SWMM_EvapPreviewSample",
                  buf + i * size,
                ) as unknown as EvapPreviewSample,
            );
            const s = readStruct(this._mod, "SWMM_EvapPreviewSummary", summary) as Record<
              string,
              number
            >;
            return {
              samples: rows,
              summary: { ...s, runtime_forcing_unknown: s.runtime_forcing_unknown !== 0 },
              diagnostic: this._mod.UTF8ToString(diagnostic, 4096),
            };
          } finally {
            this._mod._free(buf);
          }
        } finally {
          this._mod._free(diagnostic);
        }
      });
    if (!draft) return run(0);
    return withStruct(this._mod, "SWMM_EvapPreviewConfig", (cfg) => run(cfg), draft);
  }
}
