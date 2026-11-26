/**
 * @file Groundwater.ts
 * @brief Groundwater authoring and live SI diagnostics
 *        (`solver.surface2d.groundwater`, Python `openswmm.engine._groundwater`
 *        and `_gw_transport`).
 *
 * Authored rows are in project units; runtime readers are SI. The runtime
 * source and boundary-forcing members (`sources`, `setHeadBoundary`, ...)
 * arrive with the coupling wave.
 *
 * @license  Apache-2.0
 */
import {
  CellScope,
  ErrorCode,
  GroundwaterLedger,
  GroundwaterSpeciesLedger,
  GroundwaterTransportZone,
  GroundwaterVariable,
  GroundwaterZone,
} from "./enums.js";
import { BadParamError, raiseForCode } from "./errors.js";
import { checkedAlloc, guardedRaw, withCString, withCStrings, withDouble, withInt } from "./mem.js";
import { STRUCTS, type RawApi } from "./raw.js";
import { readStruct, withStruct, withStructs } from "./structs.js";
import type { OpenSwmmWasmModule } from "./types.js";
import {
  DomainSources,
  type BoundaryReceipt,
  type PerCell,
  type SourceOptions,
  type SourceReceipt,
} from "./Coupling.js";
import type { Solver } from "./Solver.js";

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
  /** Located by map coordinates (project units) instead of a cell. */
  readonly byXy?: boolean;
  readonly x?: number;
  readonly y?: number;
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

/** Text options keyed by their native INP spelling, with engine lifecycle validation. */
export class GroundwaterOptions {
  constructor(
    protected readonly mod: OpenSwmmWasmModule,
    private readonly getOption: (key: string, p: number, size: number) => number,
    private readonly setOption: (key: string, value: string) => number,
    private readonly _keys: readonly string[] = [],
  ) {}
  get length(): number {
    return this._keys.length;
  }
  [Symbol.iterator](): Iterator<string> {
    return this._keys[Symbol.iterator]();
  }
  get(key: string): string {
    return withCString(this.mod, 256, (p, n) => this.getOption(key, p, n));
  }
  set(key: string, value: string | number | boolean): void {
    raiseForCode(this.setOption(key, String(value)));
  }
  /** Options cannot be deleted; assign an explicit value. */
  delete(_key: string): never {
    throw new TypeError("Groundwater options cannot be deleted; assign an explicit value");
  }
}

const AQUIFER_KEYS = [
  "SOIL_CHAR",
  "CLOSURE",
  "M_LAYERS",
  "CAPILLARY_DIFF",
  "C_GW",
  "C_COL",
  "FORCE_CLOSED_FORM",
  "MODE",
  "DUNNE",
  "GW_ET",
  "NODE_ENROLMENT",
  "LINK_SEEPAGE",
  "GW_CLOCK",
  "GW_BASE_STEP",
  "GW_MAX_STEP",
  "GW_BUDGET_FRACTION",
  "GW_HEAD_TOLERANCE",
  "GW_BINDS_SURFACE_DT",
] as const;

const TRANSPORT_KEYS = [
  "UNSAT_TRANSPORT",
  "TRANSPORT_POLLUTANTS",
  "TRANSPORT_MSX",
  "TRANSPORT_AGE",
  "TRANSPORT_TEMPERATURE",
  "DISPERSION",
  "CONDUCTION",
  "SURFACE_THERMAL_BC",
  "DEEP_THERMAL_BC",
  "THERMAL_MIXING",
  "C_DIFF",
  "THERMAL_MODEL",
  "THERMAL_LAYERS",
  "LATERAL_CONDUCTION",
  "THERMAL_MAX_STEP",
  "WATER_THERMAL_CONDUCTIVITY",
  "AIR_THERMAL_CONDUCTIVITY",
  "SURFACE_THERMAL_RESISTANCE",
  "SOIL_ET_HEAT",
] as const;

/** `groundwater.options`: `[2D_AQUIFER_OPTIONS]` (Python `AquiferOptions`). */
export class AquiferOptions extends GroundwaterOptions {
  /** @internal */
  constructor(
    mod: OpenSwmmWasmModule,
    private readonly raw: RawApi,
    private readonly handle: number,
  ) {
    super(
      mod,
      (key, p, n) => raw.swmm_gw2d_option_get(handle, key, p, n),
      (key, value) => raw.swmm_gw2d_option_set(handle, key, value),
      AQUIFER_KEYS,
    );
  }

  /**
   * Set GW_ET, LINK_SEEPAGE and WILTING_SUCTION atomically before a run
   * (custom wilting suction in project length units). Invalid input changes
   * nothing.
   */
  setProcessOptions({
    et,
    link,
    wilting = "AUTO",
    authored = true,
  }: {
    et: string;
    link: string;
    wilting?: string | number;
    authored?: boolean;
  }): void {
    raiseForCode(
      this.raw.swmm_gw2d_process_options_set(
        this.handle,
        et,
        link,
        String(wilting),
        authored ? 1 : 0,
      ),
    );
  }
}

/** `groundwater.transport.options`: `[GW_TRANSPORT_OPTIONS]` (Python `GroundwaterTransportOptions`). */
export class GroundwaterTransportOptions extends GroundwaterOptions {
  /** @internal */
  constructor(mod: OpenSwmmWasmModule, raw: RawApi, handle: number) {
    super(
      mod,
      (key, p, n) => raw.swmm_gw_transport_option_get(handle, key, p, n),
      (key, value) => raw.swmm_gw_transport_option_set(handle, key, value),
      TRANSPORT_KEYS,
    );
  }
}

/** A node-bed row and its enrollment flags (project units). */
export interface AquiferNode {
  readonly node: string;
  /** -1 locates the cell from the node's coordinates. */
  readonly cell: number;
  readonly kc: number;
  readonly dc: number;
  readonly area: number;
  readonly locate: boolean;
  readonly exchange: boolean;
  readonly automatic: boolean;
}

/** A `[2D_AQUIFER_LINKS]` conduit-bed row: kc in seepage units, dc in project length. */
export interface AquiferLink {
  readonly link: string;
  readonly kc: number;
  readonly dc: number;
  readonly exchange: boolean;
}

/** An authored exterior-edge groundwater boundary (HEAD in project elevation, FLOW total inward m³/s). */
export interface AquiferBoundary {
  readonly cell: number;
  readonly edge: number;
  readonly kind: "HEAD" | "FLOW";
  readonly value: number;
  readonly series: string;
}

/** Thermal, material and dispersion parameters (SI); Python's defaults fill omitted fields. */
export interface GroundwaterParameters {
  readonly scope?: CellScope;
  readonly cell?: number;
  readonly rhoS?: number;
  readonly cS?: number;
  readonly lambdaS?: number;
  readonly aS?: number;
  readonly alphaL?: number;
  readonly alphaT?: number;
  readonly dM?: number;
  readonly dV?: number;
  readonly geoFlux?: number;
  readonly tag?: string;
}

/** A sorption row; `decay` -1 means none. */
export interface GroundwaterSorption {
  readonly scope?: CellScope;
  readonly tag?: string;
  readonly cell?: number;
  readonly species?: string;
  readonly kd?: number;
  readonly decay?: number;
}

/** An initial quality row (zone SAT, UNSAT or LAYER; layer -1 for zones). */
export interface GroundwaterInitialQuality {
  readonly scope?: CellScope;
  readonly tag?: string;
  readonly cell?: number;
  readonly zone?: GroundwaterTransportZone;
  readonly layer?: number;
  readonly species?: string;
  readonly value?: number;
}

/** A boundary quality row on an exterior edge (`kind` CONC by default). */
export interface GroundwaterBoundary {
  readonly cell?: number;
  readonly edge?: number;
  readonly species?: string;
  readonly kind?: string;
  readonly value?: number;
  readonly timeseries?: string;
}

const PARAMETER_DEFAULTS = {
  scope: CellScope.GLOBAL,
  cell: -1,
  rhoS: 2650,
  cS: 880,
  lambdaS: 2,
  aS: 0,
  alphaL: 1,
  alphaT: 0.1,
  dM: 1e-9,
  dV: 1e-9,
  geoFlux: 0.065,
  tag: "",
};

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
  readonly options: AquiferOptions;
  readonly transport: GroundwaterTransport;
  constructor(
    mod: OpenSwmmWasmModule,
    handle: number,
    checkOwner: () => void = () => {},
    private readonly _owner?: Solver,
  ) {
    super(mod, handle, checkOwner);
    this.options = new AquiferOptions(mod, this.raw, handle);
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

  /** Node-bed rows, automatically enrolled rows included after initialization. */
  get nodes(): AquiferNode[] {
    const count = withInt(this.mod, (p) => this.raw.swmm_gw2d_node_count(this.handle, p));
    return this.buffer(48, (p) =>
      Array.from({ length: count }, (_, i) => {
        this.mod.HEAPU8.fill(0, p, p + 48);
        const [node] = withCStrings(this.mod, 256, 1, ([b], n) =>
          this.raw.swmm_gw2d_node_get(this.handle, i, b, n, p, p + 8, p + 16, p + 24),
        );
        raiseForCode(this.raw.swmm_gw2d_node_get_flags(this.handle, i, p + 32, p + 36, p + 40));
        const f = this.mod.HEAPF64;
        const n = this.mod.HEAP32;
        return {
          node,
          cell: n[p >> 2],
          kc: f[(p + 8) >> 3],
          dc: f[(p + 16) >> 3],
          area: f[(p + 24) >> 3],
          locate: n[(p + 32) >> 2] !== 0,
          exchange: n[(p + 36) >> 2] !== 0,
          automatic: n[(p + 40) >> 2] !== 0,
        };
      }),
    );
  }

  /**
   * Compare-and-replace the whole bed list and LID bottom owners atomically.
   * `bottoms` holds `[node index, expected mode, new mode]` triples (0/1/2);
   * `apply: false` only validates. Stale or invalid edits change nothing.
   */
  replaceNodes(
    expected: readonly AquiferNode[],
    replacement: readonly AquiferNode[],
    {
      bottoms = [],
      apply = true,
    }: { bottoms?: readonly (readonly [number, number, number])[]; apply?: boolean } = {},
  ): void {
    const bed = (r: AquiferNode) => {
      if (r.node.includes("\0")) throw new RangeError("Node name contains NUL");
      return {
        node: r.node,
        cell: r.cell,
        locate: r.locate ? 1 : 0,
        exchange: r.exchange ? 1 : 0,
        automatic: r.automatic ? 1 : 0,
        kc: r.kc,
        dc: r.dc,
        area: r.area,
      };
    };
    const old = expected.map(bed);
    const neu = replacement.map(bed);
    const edits = bottoms.map(([node, expectedMode, mode]) => ({
      node,
      expected_mode: expectedMode,
      mode,
    }));
    withStructs(this.mod, "SWMM_GwNodeBed", old, (op) =>
      withStructs(this.mod, "SWMM_GwNodeBed", neu, (np) =>
        withStructs(this.mod, "SWMM_LidNodeBottomEdit", edits, (ep) =>
          raiseForCode(
            this.raw.swmm_gw2d_node_replace(
              this.handle,
              old.length ? op : 0,
              old.length,
              neu.length ? np : 0,
              neu.length,
              edits.length ? ep : 0,
              edits.length,
              apply ? 1 : 0,
            ),
          ),
        ),
      ),
    );
  }

  /**
   * Add a node bed: kc in/hr or mm/hr (0 is direct Darcy exchange), dc ft or
   * m, area ft² or m² (0 uses the cell area); cell -1 locates from the node.
   */
  addNode(node: string, cell: number, kc: number, dc: number, area = 0): void {
    raiseForCode(this.raw.swmm_gw2d_node_add(this.handle, node, cell, kc, dc, area));
  }

  /** Remove a node-bed row; later indices shift. */
  removeNode(index: number): void {
    raiseForCode(this.raw.swmm_gw2d_node_remove(this.handle, index));
  }

  /** Enable or opt out of groundwater exchange for one authored bed. */
  setNodeExchange(index: number, enabled: boolean): void {
    raiseForCode(this.raw.swmm_gw2d_node_set_exchange(this.handle, index, enabled ? 1 : 0));
  }

  /** `[2D_AQUIFER_LINKS]` conduit-bed rows. */
  get links(): AquiferLink[] {
    const count = withInt(this.mod, (p) => this.raw.swmm_gw2d_link_count(this.handle, p));
    return this.buffer(24, (p) =>
      Array.from({ length: count }, (_, i) => {
        this.mod.HEAPU8.fill(0, p, p + 24);
        const [link] = withCStrings(this.mod, 256, 1, ([b], n) =>
          this.raw.swmm_gw2d_link_get(this.handle, i, b, n, p, p + 8, p + 16),
        );
        return {
          link,
          kc: this.mod.HEAPF64[p >> 3],
          dc: this.mod.HEAPF64[(p + 8) >> 3],
          exchange: this.mod.HEAP32[(p + 16) >> 2] !== 0,
        };
      }),
    );
  }

  /** Add a conduit bed: kc in seepage units (0 = the conduit's rate), dc ft or m (0 = full depth). */
  addLink(link: string, kc = 0, dc = 0, exchange = true): void {
    raiseForCode(this.raw.swmm_gw2d_link_add(this.handle, link, kc, dc, exchange ? 1 : 0));
  }

  /** Remove a conduit-bed row; later indices shift. */
  removeLink(index: number): void {
    raiseForCode(this.raw.swmm_gw2d_link_remove(this.handle, index));
  }

  /** Recharge execution status (operators, threads, batches, backend, profile). */
  get executionStatus(): Record<string, number | boolean | string> {
    return withStruct(
      this.mod,
      "SWMM_GwExecutionStatus",
      (p) => {
        raiseForCode(this.raw.swmm_gw2d_get_execution_status(this.handle, p));
        const r = readStruct(this.mod, "SWMM_GwExecutionStatus", p) as Record<
          string,
          number | string
        >;
        return {
          active: r.active !== 0,
          availableOperators: r.available_operators,
          executedOperators: r.executed_operators,
          hostOwnedOperations: r.host_owned_operations,
          effectiveThreads: r.effective_threads,
          acceptedBatches: r.accepted_batches,
          acceptedCells: r.accepted_cells,
          rechargeBackend: r.recharge_backend,
          profile: r.profile,
          detail: r.detail,
        };
      },
      { struct_size: STRUCTS.SWMM_GwExecutionStatus.size },
    );
  }

  /** Transported species names in native order. */
  get species(): string[] {
    const n = withInt(this.mod, (p) => this.raw.swmm_gw2d_species_count(this.handle, p));
    return Array.from({ length: n }, (_, i) =>
      withCString(this.mod, 256, (b, len) =>
        this.raw.swmm_gw2d_species_name(this.handle, i, b, len),
      ),
    );
  }

  /** Authored exterior-edge boundaries. */
  get authoredBoundaries(): AquiferBoundary[] {
    const count = this.raw.swmm_gw2d_boundary_count(this.handle);
    if (count < 0) throw new Error("Unable to read authored groundwater boundaries");
    return Array.from({ length: count }, (_, i) =>
      withStruct(this.mod, "SWMM_GwBoundary", (row) => {
        for (let len = 256; ; len *= 2) {
          const buf = checkedAlloc(this.mod, len);
          try {
            this.mod.HEAPU8[buf] = 0;
            const rc = this.raw.swmm_gw2d_boundary_get(this.handle, i, row, buf, len);
            if (rc === ErrorCode.BUFSIZE && len < 64 * 1024 * 1024) continue;
            raiseForCode(rc);
            const r = readStruct(this.mod, "SWMM_GwBoundary", row) as Record<string, number>;
            return {
              cell: r.cell,
              edge: r.edge,
              kind: r.kind === 0 ? "HEAD" : "FLOW",
              value: r.value,
              series: this.mod.UTF8ToString(buf, len),
            } as AquiferBoundary;
          } finally {
            this.mod._free(buf);
          }
        }
      }),
    );
  }

  /** Author an exterior-edge boundary before initialize (quality via the transport rows). */
  setAuthoredBoundary(
    cell: number,
    edge: number,
    kind: "HEAD" | "FLOW" | string,
    value = 0,
    series = "",
  ): void {
    const selected = String(kind).toUpperCase();
    if (selected !== "HEAD" && selected !== "FLOW")
      throw new RangeError("kind must be HEAD or FLOW");
    withStructs(
      this.mod,
      "SWMM_GwBoundary",
      [{ cell, edge, kind: selected === "HEAD" ? 0 : 1, value }],
      (p) => raiseForCode(this.raw.swmm_gw2d_boundary_set(this.handle, p, series)),
    );
  }

  removeAuthoredBoundary(index: number): void {
    raiseForCode(this.raw.swmm_gw2d_boundary_remove(this.handle, index));
  }

  /** Requested/accepted boundary water, or with `species` the advective/imposed amounts. */
  authoredBoundaryReceipt(index: number, species: number | null = null): Record<string, number> {
    return this.buffer<Record<string, number>>(32, (p) => {
      this.mod.HEAPF64.fill(0, p >> 3, (p >> 3) + 4);
      const f = () => [0, 1, 2, 3].map((k) => this.mod.HEAPF64[(p >> 3) + k]);
      if (species === null) {
        raiseForCode(
          this.raw.swmm_gw2d_boundary_water(this.handle, index, p, p + 8, p + 16, p + 24),
        );
        const [a, b, c, d] = f();
        const water: Record<string, number> = {
          requestedIn: a,
          requestedOut: b,
          acceptedIn: c,
          acceptedOut: d,
        };
        return water;
      }
      raiseForCode(
        this.raw.swmm_gw2d_boundary_species(this.handle, index, species, p, p + 8, p + 16, p + 24),
      );
      const [a, b, c, d] = f();
      const amounts: Record<string, number> = {
        advectiveIn: a,
        advectiveOut: b,
        fluxIn: c,
        fluxOut: d,
      };
      return amounts;
    });
  }

  /** SIGMA inventory of one layer (zero-based): water m³, total mass, dissolved concentration. */
  layerQuality(
    cell: number,
    layer: number,
    species: number,
  ): { waterM3: number; totalMass: number; dissolvedConcentration: number } {
    return this.buffer(24, (p) => {
      this.mod.HEAPF64.fill(0, p >> 3, (p >> 3) + 3);
      raiseForCode(
        this.raw.swmm_gw2d_get_layer_quality(this.handle, cell, layer, species, p, p + 8, p + 16),
      );
      const f = this.mod.HEAPF64;
      return {
        waterM3: f[p >> 3],
        totalMass: f[(p >> 3) + 1],
        dissolvedConcentration: f[(p >> 3) + 2],
      };
    });
  }

  /** Per-cell concentration of a species in a zone. */
  concentrations(zone: GroundwaterZone, species: number): Float64Array {
    const [n] = this.dimensions;
    return this.buffer(8 * Math.max(n, 1) + 4, (p) => {
      const written = p + 8 * Math.max(n, 1);
      this.mod.HEAP32[written >> 2] = 0;
      raiseForCode(this.raw.swmm_gw2d_get_cell_conc(this.handle, zone, species, p, n, written));
      return new Float64Array(this.mod.HEAPU8.buffer, p, this.mod.HEAP32[written >> 2]).slice();
    });
  }

  /** A cumulative species ledger term, in the species' mass units. */
  speciesLedger(species: number, term: GroundwaterSpeciesLedger): number {
    return withDouble(this.mod, (p) =>
      this.raw.swmm_gw2d_get_species_ledger(this.handle, species, term, p),
    );
  }

  // ---- runtime sources and boundaries (Python `_coupling.DomainSources`) ----

  /** Runtime external sources and cumulative accepted-transfer receipts. */
  get sources(): DomainSources {
    if (!this._owner) throw new TypeError("Obtain groundwater through solver.groundwater2d");
    return new DomainSources(this._owner, "groundwater");
  }

  /** Prescribe a runtime head (m) on an exterior edge. */
  setHeadBoundary(
    cell: number,
    edge: number,
    headM: number,
    concentrations: Readonly<Record<string, number>> | null = null,
  ): void {
    this.sources.setBoundary(cell, edge, 1, headM, concentrations);
  }

  /** Prescribe a total outward flow (m³/s) on an exterior edge; negative supplies boundary water. */
  setFlowBoundary(
    cell: number,
    edge: number,
    flowM3S: number,
    concentrations: Readonly<Record<string, number>> | null = null,
  ): void {
    this.sources.setBoundary(cell, edge, 2, flowM3S, concentrations);
  }

  /** Remove a runtime edge boundary. */
  clearBoundary(cell: number, edge: number): void {
    this.sources.clearBoundary(cell, edge);
  }

  /** Last accepted outward m³/s; zero for cleared or native no-flow edges. */
  boundaryFlow(cell: number, edge: number): number {
    return this.sources.boundaryFlow(cell, edge);
  }

  /** Cumulative boundary receipt, positive inward; heat includes advection. */
  boundaryReceipt(cell: number, edge: number): BoundaryReceipt {
    return this.sources.boundaryReceipt(cell, edge);
  }

  /** Water source on one or more cells (m³/s each); see {@link DomainSources.setSource}. */
  setWaterSource(
    cells: number | ArrayLike<number>,
    flowM3S: PerCell,
    options: SourceOptions = {},
  ): void {
    this.sources.setSource(cells, flowM3S, options);
  }

  /** Heat source (W) supplied to the water of one or more cells. */
  setHeatSource(
    cells: number | ArrayLike<number>,
    heatW: PerCell,
    { sourceId = "heat", untilSeconds = null }: SourceOptions = {},
  ): void {
    this.sources.setSource(cells, 0, { heatW, sourceId, untilSeconds });
  }

  /** Species sources (concentration unit × m³/s) without water. */
  setSpeciesSource(
    cells: number | ArrayLike<number>,
    speciesRates: Readonly<Record<string, PerCell>>,
    { sourceId = "species", untilSeconds = null }: SourceOptions = {},
  ): void {
    this.sources.setSource(cells, 0, { speciesRates, sourceId, untilSeconds });
  }

  /** Clear a source ID on every cell, or on one cell. */
  clearSource(sourceId = "external", cell: number | null = null): void {
    this.sources.clearSource(sourceId, cell);
  }

  /** Cumulative receipt of one source on one cell. */
  sourceReceipt(sourceId = "external", cell = 0): SourceReceipt {
    return this.sources.sourceReceipt(sourceId, cell);
  }
}

/** Named source authoring. Coordinates use project map units; flows use m³/s. */
export class GroundwaterTransport extends GroundwaterView {
  readonly options: GroundwaterTransportOptions;
  constructor(mod: OpenSwmmWasmModule, handle: number, checkOwner: () => void = () => {}) {
    super(mod, handle, checkOwner);
    this.options = new GroundwaterTransportOptions(mod, this.raw, handle);
  }
  get sources(): readonly GroundwaterSource[] {
    const count = this.raw.swmm_gw_source_count(this.handle);
    return this.buffer(40, (p) =>
      Array.from({ length: count }, (_, i) => {
        const [name, tag, flowTimeseries] = withCStrings(this.mod, 256, 3, ([name, tag, ts], n) =>
          this.raw.swmm_gw_source_get(this.handle, i, name, n, p, tag, n, p + 4, p + 8, ts, n),
        );
        this.mod.HEAPU8.fill(0, p + 16, p + 40);
        raiseForCode(this.raw.swmm_gw_source_xy_get(this.handle, i, p + 16, p + 24, p + 32));
        return {
          name,
          scope: this.mod.getValue(p, "i32"),
          tag,
          cell: this.mod.getValue(p + 4, "i32"),
          flow: this.mod.getValue(p + 8, "double"),
          flowTimeseries,
          byXy: this.mod.getValue(p + 16, "i32") !== 0,
          x: this.mod.getValue(p + 24, "double"),
          y: this.mod.getValue(p + 32, "double"),
        };
      }),
    );
  }
  /** Add or replace a source; `byXy` needs CELL scope, a mesh and finite coordinates. */
  setSource(row: GroundwaterSource): void {
    if (row.byXy) {
      const cells = withInt(this.mod, (p) => this.raw.swmm_2d_cell_count(this.handle, p));
      if (
        row.scope !== CellScope.CELL ||
        cells === 0 ||
        !Number.isFinite(row.x) ||
        !Number.isFinite(row.y)
      ) {
        throw new BadParamError("XY sources require CELL scope, a mesh and finite coordinates");
      }
    }
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
    if (row.byXy) {
      const index = this.sources.findIndex((s) => s.name === row.name);
      if (index >= 0)
        raiseForCode(this.raw.swmm_gw_source_xy_set(this.handle, index, row.x!, row.y!));
    }
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

  /** Whether any groundwater transport section was authored. */
  get authored(): boolean {
    return this.raw.swmm_gw_transport_authored(this.handle) !== 0;
  }

  /** Thermal/material/dispersion parameter rows (SI). */
  get parameters(): Required<GroundwaterParameters>[] {
    const count = this.raw.swmm_gw_params_count(this.handle);
    return Array.from({ length: count }, (_, i) =>
      withStruct(this.mod, "SWMM_GwParams", (p) => {
        const [tag] = withCStrings(this.mod, 256, 1, ([b], n) =>
          this.raw.swmm_gw_params_get(this.handle, i, p, b, n),
        );
        const r = readStruct(this.mod, "SWMM_GwParams", p) as Record<string, number>;
        return {
          scope: r.scope,
          cell: r.cell,
          rhoS: r.rho_s,
          cS: r.c_s,
          lambdaS: r.lambda_s,
          aS: r.a_s,
          alphaL: r.alpha_L,
          alphaT: r.alpha_T,
          dM: r.D_m,
          dV: r.D_v,
          geoFlux: r.geo_flux,
          tag,
        };
      }),
    );
  }

  /** Add or replace material parameters by scope/tag/cell (before initialization). */
  setParameters(row: GroundwaterParameters = {}): void {
    const v = { ...PARAMETER_DEFAULTS, ...row };
    withStructs(
      this.mod,
      "SWMM_GwParams",
      [
        {
          scope: v.scope,
          cell: v.cell,
          rho_s: v.rhoS,
          c_s: v.cS,
          lambda_s: v.lambdaS,
          a_s: v.aS,
          alpha_L: v.alphaL,
          alpha_T: v.alphaT,
          D_m: v.dM,
          D_v: v.dV,
          geo_flux: v.geoFlux,
        },
      ],
      (p) => raiseForCode(this.raw.swmm_gw_params_set(this.handle, p, v.tag)),
    );
  }

  removeParameters(index: number): void {
    raiseForCode(this.raw.swmm_gw_params_remove(this.handle, index));
  }

  /** Sorption rows in native order. */
  get sorption(): Required<GroundwaterSorption>[] {
    const count = this.raw.swmm_gw_sorption_count(this.handle);
    if (count < 0) throw new RangeError("Invalid native row owner/index");
    return this.buffer(24, (p) =>
      Array.from({ length: count }, (_, i) => {
        const [tag, species] = withCStrings(this.mod, 256, 2, ([tb, sb], n) =>
          this.raw.swmm_gw_sorption_get(this.handle, i, p, tb, n, p + 4, sb, n, p + 8, p + 16),
        );
        return {
          scope: this.mod.HEAP32[p >> 2],
          tag,
          cell: this.mod.HEAP32[(p + 4) >> 2],
          species,
          kd: this.mod.HEAPF64[(p + 8) >> 3],
          decay: this.mod.HEAPF64[(p + 16) >> 3],
        };
      }),
    );
  }

  /** Add or replace a sorption row (BUILDING or OPENED). */
  setSorption(row: GroundwaterSorption): void {
    raiseForCode(
      this.raw.swmm_gw_sorption_set(
        this.handle,
        row.scope ?? CellScope.GLOBAL,
        row.tag ?? "",
        row.cell ?? -1,
        row.species ?? "",
        row.kd ?? 0,
        row.decay ?? -1,
      ),
    );
  }

  removeSorption(index: number): void {
    raiseForCode(this.raw.swmm_gw_sorption_remove(this.handle, index));
  }

  /** Initial quality rows in native order. */
  get initialQuality(): Required<GroundwaterInitialQuality>[] {
    const count = this.raw.swmm_gw_init_quality_count(this.handle);
    if (count < 0) throw new RangeError("Invalid native row owner/index");
    return this.buffer(24, (p) =>
      Array.from({ length: count }, (_, i) => {
        const [tag, species] = withCStrings(this.mod, 256, 2, ([tb, sb], n) =>
          this.raw.swmm_gw_init_quality_get(
            this.handle,
            i,
            p,
            tb,
            n,
            p + 4,
            p + 8,
            p + 12,
            sb,
            n,
            p + 16,
          ),
        );
        const h = this.mod.HEAP32;
        return {
          scope: h[p >> 2],
          tag,
          cell: h[(p + 4) >> 2],
          zone: h[(p + 8) >> 2] as GroundwaterTransportZone,
          layer: h[(p + 12) >> 2],
          species,
          value: this.mod.HEAPF64[(p + 16) >> 3],
        };
      }),
    );
  }

  /** Add or replace an initial quality row (BUILDING or OPENED). */
  setInitialQuality(row: GroundwaterInitialQuality): void {
    raiseForCode(
      this.raw.swmm_gw_init_quality_set(
        this.handle,
        row.scope ?? CellScope.GLOBAL,
        row.tag ?? "",
        row.cell ?? -1,
        row.zone ?? GroundwaterTransportZone.SAT,
        row.layer ?? -1,
        row.species ?? "",
        row.value ?? 0,
      ),
    );
  }

  removeInitialQuality(index: number): void {
    raiseForCode(this.raw.swmm_gw_init_quality_remove(this.handle, index));
  }

  /** Boundary quality rows in native order. */
  get boundaries(): Required<GroundwaterBoundary>[] {
    const count = this.raw.swmm_gw_boundary_quality_count(this.handle);
    if (count < 0) throw new RangeError("Invalid native row owner/index");
    return this.buffer(16, (p) =>
      Array.from({ length: count }, (_, i) => {
        const [species, kind, timeseries] = withCStrings(this.mod, 256, 3, ([sb, kb, tb], n) =>
          this.raw.swmm_gw_boundary_quality_get(
            this.handle,
            i,
            p,
            p + 4,
            sb,
            n,
            kb,
            n,
            p + 8,
            tb,
            n,
          ),
        );
        return {
          cell: this.mod.HEAP32[p >> 2],
          edge: this.mod.HEAP32[(p + 4) >> 2],
          species,
          kind,
          value: this.mod.HEAPF64[(p + 8) >> 3],
          timeseries,
        };
      }),
    );
  }

  /** Add or replace a boundary quality row (BUILDING or OPENED). */
  setBoundary(row: GroundwaterBoundary): void {
    raiseForCode(
      this.raw.swmm_gw_boundary_quality_set(
        this.handle,
        row.cell ?? 0,
        row.edge ?? 0,
        row.species ?? "",
        row.kind ?? "CONC",
        row.value ?? 0,
        row.timeseries ?? "",
      ),
    );
  }

  removeBoundary(index: number): void {
    raiseForCode(this.raw.swmm_gw_boundary_quality_remove(this.handle, index));
  }

  /** The authored initial-quality sidecar path (read at the next open). */
  get initialQualityFile(): string {
    return withCString(this.mod, 256, (b, n) =>
      this.raw.swmm_gw_init_quality_file_get(this.handle, b, n),
    );
  }
  set initialQualityFile(path: string | null) {
    raiseForCode(this.raw.swmm_gw_init_quality_file_set(this.handle, path ?? ""));
  }
}
