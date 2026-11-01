/** Groundwater authoring and live SI diagnostics (solver.surface2d.groundwater). */
import { CellScope, GroundwaterLedger, GroundwaterVariable } from "./enums.js";
import { raiseForCode } from "./errors.js";
import { checkedAlloc, guardedRaw, withCString, withCStrings, withDouble, withInt } from "./mem.js";
import { STRUCTS, type RawApi } from "./raw.js";
import type { OpenSwmmWasmModule } from "./types.js";

export interface AquiferRow {
  readonly scope: CellScope;
  readonly tag?: string;
  readonly cell?: number;
  /** Authored project units: in/hr or mm/hr. */
  readonly ks: number;
  /** Authored project length units. */
  readonly zs: number;
  readonly thetaS: number;
  readonly thetaR: number;
  readonly alpha: number;
}

export interface GroundwaterSource {
  readonly name: string;
  readonly scope: CellScope;
  readonly tag?: string;
  readonly cell: number;
  /** SI m³/s. */
  readonly flow: number;
  readonly flowTimeseries?: string;
}

export interface GroundwaterSourceTerm {
  readonly species: string;
  readonly kind: string;
  readonly value: number;
  readonly timeseries?: string;
}

export interface GroundwaterClosureStats {
  readonly firings: bigint;
  readonly subcycledFirings: bigint;
  readonly budgetFirings: bigint;
  readonly meanElapsed: number;
  readonly maxElapsed: number;
  readonly maxBudgetExcessIn: number;
  readonly maxBudgetExcessOut: number;
  readonly budgetExceedance: readonly bigint[];
  readonly maxReturnDepth: number;
}

export interface GroundwaterClockStats {
  readonly independent: boolean;
  readonly firstRung: number;
  readonly lastRung: number;
  readonly occupiedRungs: number;
  /** Empty in shared-clock mode. Durations are seconds; excess water is m³. */
  readonly closures: Partial<Record<"CLOSED_FORM" | "ENSLAVED" | "SIGMA", GroundwaterClosureStats>>;
}

/** Text options retain native INP spelling and engine lifecycle validation. */
export class GroundwaterOptions {
  constructor(
    private readonly mod: OpenSwmmWasmModule,
    private readonly getOption: (key: string, p: number, size: number) => number,
    private readonly setOption: (key: string, value: string) => number,
  ) {}
  get(key: string): string {
    return withCString(this.mod, 256, (p, n) => this.getOption(key, p, n));
  }
  set(key: string, value: string | number | boolean): void {
    raiseForCode(this.setOption(key, String(value)));
  }
}

class GroundwaterView {
  protected readonly raw: RawApi;
  constructor(
    protected readonly mod: OpenSwmmWasmModule,
    protected readonly handle: number,
    checkOwner: () => void,
  ) {
    this.raw = guardedRaw(mod, checkOwner);
  }
  protected buffer<T>(bytes: number, use: (p: number) => T): T {
    const p = checkedAlloc(this.mod, bytes);
    try {
      return use(p);
    } finally {
      this.mod._free(p);
    }
  }
}

export class Groundwater extends GroundwaterView {
  readonly options: GroundwaterOptions;
  readonly transport: GroundwaterTransport;
  constructor(mod: OpenSwmmWasmModule, handle: number, checkOwner: () => void = () => {}) {
    super(mod, handle, checkOwner);
    this.options = new GroundwaterOptions(
      mod,
      (key, p, n) => this.raw.swmm_gw2d_option_get(handle, key, p, n),
      (key, value) => this.raw.swmm_gw2d_option_set(handle, key, value),
    );
    this.transport = new GroundwaterTransport(mod, handle, checkOwner);
  }
  get active(): boolean {
    return Boolean(withInt(this.mod, (p) => this.raw.swmm_gw2d_is_active(this.handle, p)));
  }
  get dimensions(): readonly [number, number] {
    return this.buffer(8, (p) => {
      raiseForCode(this.raw.swmm_gw2d_get_dimensions(this.handle, p, p + 4));
      return [this.mod.getValue(p, "i32"), this.mod.getValue(p + 4, "i32")];
    });
  }
  get rows(): readonly AquiferRow[] {
    const count = withInt(this.mod, (p) => this.raw.swmm_gw2d_row_count(this.handle, p));
    return this.buffer(48, (p) =>
      Array.from({ length: count }, (_, i) => {
        const tag = withCString(this.mod, 256, (tag, n) =>
          this.raw.swmm_gw2d_row_get(
            this.handle,
            i,
            p,
            tag,
            n,
            p + 4,
            p + 8,
            p + 16,
            p + 24,
            p + 32,
            p + 40,
          ),
        );
        const d = (offset: number) => this.mod.getValue(p + offset, "double");
        return {
          scope: this.mod.getValue(p, "i32"),
          tag,
          cell: this.mod.getValue(p + 4, "i32"),
          ks: d(8),
          zs: d(16),
          thetaS: d(24),
          thetaR: d(32),
          alpha: d(40),
        };
      }),
    );
  }
  addRow(row: AquiferRow): void {
    raiseForCode(
      this.raw.swmm_gw2d_row_add(
        this.handle,
        row.scope,
        row.tag ?? "",
        row.cell ?? -1,
        row.ks,
        row.zs,
        row.thetaS,
        row.thetaR,
        row.alpha,
      ),
    );
  }
  removeRow(index: number): void {
    raiseForCode(this.raw.swmm_gw2d_row_remove(this.handle, index));
  }
  rowProperty(index: number, key: string): number {
    return withDouble(this.mod, (p) =>
      this.raw.swmm_gw2d_row_get_property(this.handle, index, key, p),
    );
  }
  setRowProperty(index: number, key: string, value: number): void {
    raiseForCode(this.raw.swmm_gw2d_row_set_property(this.handle, index, key, value));
  }
  /** Runtime value in SI. */
  cell(cell: number, variable: GroundwaterVariable): number {
    return withDouble(this.mod, (p) => this.raw.swmm_gw2d_get_cell(this.handle, cell, variable, p));
  }
  cells(variable: GroundwaterVariable): Float64Array {
    return this.readArray(this.dimensions[0], (p, n, w) =>
      this.raw.swmm_gw2d_get_cell_bulk(this.handle, variable, p, n, w),
    );
  }
  column(cell: number): Float64Array {
    return this.readArray(this.dimensions[1], (p, n, w) =>
      this.raw.swmm_gw2d_get_column(this.handle, cell, p, n, w),
    );
  }
  private readArray(
    n: number,
    call: (p: number, n: number, written: number) => number,
  ): Float64Array {
    return this.buffer(8 * n + 8, (p) => {
      const w = p + 8 * n;
      raiseForCode(call(p, n, w));
      const written = this.mod.getValue(w, "i32");
      if (written < 0 || written > n) throw new RangeError("Invalid groundwater result length");
      return new Float64Array(this.mod.HEAPF64.buffer, p, written).slice();
    });
  }
  ledger(term: GroundwaterLedger): number {
    return withDouble(this.mod, (p) => this.raw.swmm_gw2d_get_ledger(this.handle, term, p));
  }
  get continuityError(): number {
    return withDouble(this.mod, (p) => this.raw.swmm_gw2d_get_continuity_error(this.handle, p));
  }
  get tierHistogram(): Int32Array {
    for (let n = 16; ; n *= 2) {
      const result = this.buffer(4 * n + 4, (p) => {
        raiseForCode(this.raw.swmm_gw2d_get_tier_histogram(this.handle, p, n, p + 4 * n));
        const written = this.mod.getValue(p + 4 * n, "i32");
        if (written < 0 || written > n) throw new RangeError("Invalid tier histogram length");
        return new Int32Array(this.mod.HEAP32.buffer, p, written).slice();
      });
      if (result.length < n) return result;
    }
  }

  get clockStats(): GroundwaterClockStats {
    const layout = STRUCTS.SWMM_GwClockStats;
    return this.buffer(layout.size, (p) => {
      this.mod.HEAPU8.fill(0, p, p + layout.size);
      this.mod.setValue(p + layout.fields.struct_size.offset, layout.size, "i32");
      raiseForCode(this.raw.swmm_gw2d_get_clock_stats(this.handle, p));
      const view = new DataView(this.mod.HEAPU8.buffer);
      const offset = (key: keyof typeof layout.fields, i = 0) =>
        p + layout.fields[key].offset + 8 * i;
      const int = (key: keyof typeof layout.fields) => view.getInt32(offset(key), true);
      const independent = Boolean(int("independent"));
      const closures: GroundwaterClockStats["closures"] = {};
      if (independent) {
        (["CLOSED_FORM", "ENSLAVED", "SIGMA"] as const).forEach((name, i) => {
          const u64 = (key: keyof typeof layout.fields, index = i) =>
            view.getBigUint64(offset(key, index), true);
          const f64 = (key: keyof typeof layout.fields) => view.getFloat64(offset(key, i), true);
          closures[name] = {
            firings: u64("firings"),
            subcycledFirings: u64("subcycled_firings"),
            budgetFirings: u64("budget_firings"),
            meanElapsed: f64("mean_elapsed"),
            maxElapsed: f64("max_elapsed"),
            maxBudgetExcessIn: f64("max_budget_excess_in"),
            maxBudgetExcessOut: f64("max_budget_excess_out"),
            maxReturnDepth: f64("max_return_depth"),
            budgetExceedance: Array.from({ length: 5 }, (_, j) =>
              u64("budget_exceedance", i * 5 + j),
            ),
          };
        });
      }
      return {
        independent,
        firstRung: int("first_rung"),
        lastRung: int("last_rung"),
        occupiedRungs: int("occupied_rungs"),
        closures,
      };
    });
  }
}

/** Named source authoring. Coordinates use project map units; flows use m³/s. */
export class GroundwaterTransport extends GroundwaterView {
  readonly options: GroundwaterOptions;
  constructor(mod: OpenSwmmWasmModule, handle: number, checkOwner: () => void = () => {}) {
    super(mod, handle, checkOwner);
    this.options = new GroundwaterOptions(
      mod,
      (key, p, n) => this.raw.swmm_gw_transport_option_get(handle, key, p, n),
      (key, value) => this.raw.swmm_gw_transport_option_set(handle, key, value),
    );
  }
  get sources(): readonly GroundwaterSource[] {
    const count = this.raw.swmm_gw_source_count(this.handle);
    return this.buffer(16, (p) =>
      Array.from({ length: count }, (_, i) => {
        const [name, tag, flowTimeseries] = withCStrings(this.mod, 256, 3, ([name, tag, ts], n) =>
          this.raw.swmm_gw_source_get(this.handle, i, name, n, p, tag, n, p + 4, p + 8, ts, n),
        );
        return {
          name,
          scope: this.mod.getValue(p, "i32"),
          tag,
          cell: this.mod.getValue(p + 4, "i32"),
          flow: this.mod.getValue(p + 8, "double"),
          flowTimeseries,
        };
      }),
    );
  }
  setSource(row: GroundwaterSource): void {
    raiseForCode(
      this.raw.swmm_gw_source_set(
        this.handle,
        row.name,
        row.scope,
        row.tag ?? "",
        row.cell,
        row.flow,
        row.flowTimeseries ?? "",
      ),
    );
  }
  removeSource(index: number): void {
    raiseForCode(this.raw.swmm_gw_source_remove(this.handle, index));
  }
  sourceScale(index: number): number {
    return withDouble(this.mod, (p) => this.raw.swmm_gw_source_scale_get(this.handle, index, p));
  }
  setSourceScale(index: number, value: number): void {
    raiseForCode(this.raw.swmm_gw_source_scale_set(this.handle, index, value));
  }
  sourceXy(index: number): readonly [number, number] | null {
    return this.buffer(24, (p) => {
      raiseForCode(this.raw.swmm_gw_source_xy_get(this.handle, index, p, p + 8, p + 16));
      return this.mod.getValue(p, "i32")
        ? [this.mod.getValue(p + 8, "double"), this.mod.getValue(p + 16, "double")]
        : null;
    });
  }
  setSourceXy(index: number, x: number, y: number): void {
    raiseForCode(this.raw.swmm_gw_source_xy_set(this.handle, index, x, y));
  }
  sourceSpecies(index: number): readonly GroundwaterSourceTerm[] {
    const count = this.raw.swmm_gw_source_species_count(this.handle, index);
    if (count < 0) raiseForCode(8);
    return this.buffer(8, (p) =>
      Array.from({ length: count }, (_, i) => {
        const [species, kind, timeseries] = withCStrings(
          this.mod,
          256,
          3,
          ([species, kind, ts], n) =>
            this.raw.swmm_gw_source_species_get(
              this.handle,
              index,
              i,
              species,
              n,
              kind,
              n,
              p,
              ts,
              n,
            ),
        );
        return { species, kind, value: this.mod.getValue(p, "double"), timeseries };
      }),
    );
  }
  setSourceSpecies(index: number, row: GroundwaterSourceTerm): void {
    raiseForCode(
      this.raw.swmm_gw_source_species_set(
        this.handle,
        index,
        row.species,
        row.kind,
        row.value,
        row.timeseries ?? "",
      ),
    );
  }
  removeSourceSpecies(index: number, term: number): void {
    raiseForCode(this.raw.swmm_gw_source_species_remove(this.handle, index, term));
  }
}
