/**
 * @file Coupling.ts
 * @brief Runtime exchange sources, boundaries and forcing (Python `_coupling`).
 *
 * All water rates are total SI m³/s per cell. Concentrations follow each
 * domain's species getter (°C for `__TEMPERATURE__`, seconds for
 * `__WATER_AGE__`); species rates use concentration unit × m³/s; heat is W
 * supplied to the water only. Different source IDs add; reusing an ID and cell
 * replaces its held prescription.
 *
 * Records are plain objects with camelCase keys. A provider ID
 * ({@link Coupling.forProvider}) owns its prescriptions: frames from one
 * provider never replace another's.
 *
 * @license  Apache-2.0
 */

import { raiseForCode } from "./errors.js";
import { checkedAlloc } from "./mem.js";
import { STRUCTS } from "./raw.js";
import { withStruct, withStructs, readStruct, type StructValue } from "./structs.js";
import type { Solver } from "./Solver.js";
import { SolverView } from "./view.js";

/** The two runtime exchange domains. */
export type CouplingDomain = "surface" | "groundwater";

/** One cell prescription. `untilSeconds` omitted or `null` holds it until replaced or cleared. */
export interface RuntimeSource {
  sourceId: string;
  domain: CouplingDomain;
  cell: number;
  flowM3S?: number;
  concentrations?: Readonly<Record<string, number>>;
  speciesRates?: Readonly<Record<string, number>>;
  heatW?: number;
  untilSeconds?: number | null;
}

/** A runtime edge boundary: `kind` 0 clears, 1 is head (m), 2 is total outward flow (m³/s). */
export interface RuntimeBoundary {
  domain: CouplingDomain;
  cell: number;
  edge: number;
  kind: number;
  value?: number;
  concentrations?: Readonly<Record<string, number>>;
}

/** Surface forcing of one cell (`cell` -1: every cell), in m/s. */
export interface RuntimeForcing {
  channel: "rainfall" | "evaporation" | "infiltration" | "rain_quality";
  cell?: number;
  rateMS?: number;
  mode?: "replace" | "add" | "clear";
  concentrations?: Readonly<Record<string, number>> | null;
  untilSeconds?: number | null;
}

/** Clear one provider's source ID on one cell (`cell` -1: every cell). */
export interface RuntimeClear {
  sourceId: string;
  domain: CouplingDomain;
  cell?: number;
}

/** An atomic update of sources, boundaries, forcing and clears across both domains. */
export interface CouplingFrame {
  sources?: Iterable<RuntimeSource>;
  boundaries?: Iterable<RuntimeBoundary>;
  forcings?: Iterable<RuntimeForcing>;
  clears?: Iterable<RuntimeClear>;
}

/** Cumulative accepted transfer of one source on one cell. */
export interface SourceReceipt {
  requestedM3: number;
  appliedM3: number;
  rejectedM3: number;
  requestedHeatJ: number;
  appliedHeatJ: number;
  rejectedHeatJ: number;
  requestedSpecies: Record<string, number>;
  appliedSpecies: Record<string, number>;
  lastAppliedM3S: number;
  lastIntervalSeconds: number;
  /** Requested minus applied, per species. */
  rejectedSpecies: Record<string, number>;
  /** Why part of the request was refused (empty when all of it was applied). */
  limiterReasons: string[];
}

/** Boundary or paired transfer receipt, positive inward; heat includes advection. */
export interface BoundaryReceipt extends SourceReceipt {
  /** `["water_or_receiver_capacity"]` when part of the transfer was refused. */
  limiterReasons: string[];
}

/** Which runtime exchanges the current engine configuration supports. */
export interface CouplingCapabilities {
  surfaceSources: boolean;
  groundwaterSources: boolean;
  surfaceWaterHeat: boolean;
  surfaceBoundaries: boolean;
  groundwaterWaterHeat: boolean;
  groundwaterSoilHeat: boolean;
  groundwaterLateralBoundaries: boolean;
  atomicFrames: boolean;
  rainfallQuality: boolean;
  pairedInfiltration: boolean;
  boundaryReceipts: boolean;
  rollback: boolean;
}

/** Gross accepted source water since start, m³. */
export interface CouplingWaterTotals {
  externalIn: number;
  externalOut: number;
}

/** The surface species ledger terms, in the species' mass units. */
export interface SurfaceSpeciesLedger {
  storage: number;
  externalIn: number;
  externalOut: number;
  boundaryIn: number;
  boundaryOut: number;
  rainfallIn: number;
  infiltrationOut: number;
  couplingIn: number;
  couplingOut: number;
  exfiltrationIn: number;
  ageGenerated: number;
  reacted: number;
}

const LEDGER_TERMS: (keyof SurfaceSpeciesLedger)[] = [
  "storage",
  "externalIn",
  "externalOut",
  "boundaryIn",
  "boundaryOut",
  "rainfallIn",
  "infiltrationOut",
  "couplingIn",
  "couplingOut",
  "exfiltrationIn",
  "ageGenerated",
  "reacted",
];

const CHANNELS = { rainfall: 1, evaporation: 2, infiltration: 3, rain_quality: 4 } as const;
const MODES = { clear: 0, replace: 1, add: 2 } as const;
const DOMAIN_CODE = { surface: 0, groundwater: 1 } as const;

const isInteger = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

function checkDomain(domain: unknown, message = "domain must be surface or groundwater"): void {
  if (domain !== "surface" && domain !== "groundwater") throw new RangeError(message);
}

function checkId(id: unknown, message: string): asserts id is string {
  if (typeof id !== "string" || !id || id.includes("\0")) throw new RangeError(message);
}

/** Native receipt plus per-species amounts, as a {@link SourceReceipt}. */
function receiptOf(
  row: Record<string, unknown>,
  names: readonly string[],
  requested: Float64Array,
  applied: Float64Array,
  boundary: boolean,
): SourceReceipt {
  const n = (k: string) => row[k] as number;
  const requestedSpecies = Object.fromEntries(names.map((s, i) => [s, requested[i]]));
  const appliedSpecies = Object.fromEntries(names.map((s, i) => [s, applied[i]]));
  const rejectedSpecies = Object.fromEntries(
    names.map((s) => [s, requestedSpecies[s] - appliedSpecies[s]]),
  );
  const rejectedM3 = n("rejected_m3");
  const limiterReasons: string[] = [];
  if (boundary) {
    if (rejectedM3) limiterReasons.push("water_or_receiver_capacity");
  } else {
    if (rejectedM3) limiterReasons.push("insufficient_water");
    if (n("rejected_heat_j")) limiterReasons.push("dry_cell_heat");
    if (Object.values(rejectedSpecies).some(Boolean)) {
      limiterReasons.push("insufficient_species_or_water");
    }
  }
  return {
    requestedM3: n("requested_m3"),
    appliedM3: n("applied_m3"),
    rejectedM3,
    requestedHeatJ: n("requested_heat_j"),
    appliedHeatJ: n("applied_heat_j"),
    rejectedHeatJ: n("rejected_heat_j"),
    requestedSpecies,
    appliedSpecies,
    lastAppliedM3S: n("last_applied_m3_s"),
    lastIntervalSeconds: n("last_interval_seconds"),
    rejectedSpecies,
    limiterReasons,
  };
}

/** Runtime exchange of one provider (Python `solver.coupling`; `""` is the default provider). */
export class Coupling extends SolverView {
  private readonly _provider: string;

  /** @internal Obtain through {@link Solver.coupling}. */
  constructor(owner: Solver, provider = "") {
    super(owner, true);
    if (typeof provider !== "string" || provider.includes("/") || provider.includes("\0")) {
      throw new RangeError("provider must be a string without slash or NUL");
    }
    this._provider = provider;
  }

  /** The provider ID owning this view's prescriptions (`""`: the default provider). */
  get providerId(): string {
    return this._provider;
  }

  /** The same solver's exchange as another provider. */
  forProvider(name: string): Coupling {
    void this._h;
    return new Coupling(this._solver, name);
  }

  /** Sources, boundaries, forcing and receipts of the 2D surface. */
  get surface(): DomainSources {
    void this._h;
    return new DomainSources(this._solver, "surface", this._provider);
  }

  /** Sources, boundaries and receipts of the 2D groundwater. */
  get groundwater(): DomainSources {
    void this._h;
    return new DomainSources(this._solver, "groundwater", this._provider);
  }

  /** Which runtime exchanges the current configuration supports. */
  get capabilities(): CouplingCapabilities {
    const h = this._h;
    const p = checkedAlloc(this._mod, 4);
    let flags: number;
    try {
      const rc = this._solver._operation(() => this._raw.swmm_coupling_capabilities(h, p));
      raiseForCode(rc, rc ? this._raw.swmm_get_last_error_msg(h) : undefined);
      flags = this._mod.HEAPU32[p >> 2];
    } finally {
      this._mod._free(p);
    }
    const bit = (b: number) => Boolean(flags & b);
    return {
      surfaceSources: bit(1),
      groundwaterSources: bit(2),
      surfaceWaterHeat: bit(4),
      surfaceBoundaries: bit(8),
      groundwaterWaterHeat: bit(16),
      groundwaterSoilHeat: false,
      groundwaterLateralBoundaries: bit(32),
      atomicFrames: bit(64),
      rainfallQuality: bit(128),
      pairedInfiltration: bit(256),
      boundaryReceipts: bit(512),
      rollback: false,
    };
  }

  /** Replace this provider's sources ({@link applyFrame} with sources only). */
  setSources(records: Iterable<RuntimeSource>): void {
    this.applyFrame({ sources: records });
  }

  /** Atomically update sources, boundaries and forcing across both domains. */
  applyFrame(frame: CouplingFrame): void {
    if (!frame || typeof frame !== "object") throw new TypeError("expected CouplingFrame");
    const h = this._h;
    const mod = this._mod;
    const solver = this._solver;
    const speciesOf = (domain: CouplingDomain) =>
      domain === "surface" ? solver.surface2d.species : solver.groundwater2d.species;
    const arrays: number[] = [];
    const doubles = (values: number[]): number => {
      const p = checkedAlloc(mod, 8 * Math.max(values.length, 1));
      arrays.push(p);
      mod.HEAPF64.set(values, p >> 3);
      return p;
    };
    const unknownIn = (given: object, names: readonly string[]) =>
      Object.keys(given).filter((k) => !names.includes(k));
    try {
      const sources: StructValue[] = [];
      for (const record of frame.sources ?? []) {
        if (!record || typeof record !== "object") {
          throw new TypeError("records must contain RuntimeSource objects");
        }
        checkDomain(record.domain);
        checkId(record.sourceId, "source_id must be nonempty and contain no NUL");
        if (record.sourceId.startsWith("boundary/") || record.sourceId.startsWith("provider/")) {
          throw new RangeError("boundary/ source IDs are reserved for hydraulic boundaries");
        }
        const until = record.untilSeconds ?? null;
        if (until !== null && (!Number.isFinite(until) || until <= 0)) {
          throw new RangeError("until_seconds must be a finite future time; use null to hold");
        }
        if (!isInteger(record.cell)) throw new RangeError("cell must be an integer");
        const names = speciesOf(record.domain);
        const heat = record.heatW ?? 0;
        if (heat !== 0 && !names.includes("__TEMPERATURE__")) {
          throw new RangeError(
            `Water temperature transport is not enabled for ${record.domain}; soil heat conduction is unsupported`,
          );
        }
        const conc = record.concentrations ?? {};
        const rates = record.speciesRates ?? {};
        const unknown = [...new Set([...unknownIn(conc, names), ...unknownIn(rates, names)])];
        if (unknown.length) {
          throw new RangeError(`Unknown or disabled species: [${unknown.sort().join(", ")}]`);
        }
        sources.push({
          struct_size: STRUCTS.SWMM_CouplingSource.size,
          id: record.sourceId,
          domain: DOMAIN_CODE[record.domain],
          cell: record.cell,
          flow_m3_s: record.flowM3S ?? 0,
          heat_w: heat,
          until_seconds: until ?? 0,
          species_count: names.length,
          concentrations: doubles(names.map((n) => conc[n] ?? 0)),
          rates: doubles(names.map((n) => rates[n] ?? 0)),
        });
      }
      const boundaries: StructValue[] = [];
      for (const record of frame.boundaries ?? []) {
        if (!record || typeof record !== "object") throw new TypeError("expected RuntimeBoundary");
        checkDomain(record.domain, "invalid domain");
        if (!isInteger(record.cell) || !isInteger(record.edge)) {
          throw new RangeError("cell and edge must be integers");
        }
        const names = speciesOf(record.domain);
        const conc = record.concentrations ?? {};
        if (unknownIn(conc, names).length) throw new RangeError("unknown or disabled species");
        boundaries.push({
          struct_size: STRUCTS.SWMM_CouplingBoundary.size,
          domain: DOMAIN_CODE[record.domain],
          cell: record.cell,
          edge: record.edge,
          kind: record.kind,
          value: record.value ?? 0,
          species_count: record.kind === 0 ? 0 : names.length,
          concentrations: doubles(names.map((n) => conc[n] ?? 0)),
        });
      }
      const forcings: StructValue[] = [];
      for (const record of frame.forcings ?? []) {
        if (!record || typeof record !== "object") throw new TypeError("expected RuntimeForcing");
        const mode = record.mode ?? "replace";
        if (!(record.channel in CHANNELS) || !(mode in MODES)) {
          throw new RangeError("invalid forcing channel/mode");
        }
        const cell = record.cell ?? -1;
        if (!isInteger(cell)) throw new RangeError("cell must be an integer");
        const given = record.concentrations ?? null;
        const names = given !== null ? solver.surface2d.species : [];
        if (unknownIn(given ?? {}, names).length) {
          throw new RangeError("unknown or disabled species");
        }
        forcings.push({
          struct_size: STRUCTS.SWMM_CouplingForcing.size,
          channel: CHANNELS[record.channel],
          cell,
          mode: MODES[mode],
          rate_m_s: record.rateMS ?? 0,
          until_seconds: record.untilSeconds ?? 0,
          species_count: mode === "clear" ? 0 : names.length,
          concentrations: doubles(names.map((n) => given?.[n] ?? 0)),
        });
      }
      const clears: StructValue[] = [];
      for (const record of frame.clears ?? []) {
        if (!record || typeof record !== "object") throw new TypeError("expected RuntimeClear");
        checkDomain(record.domain, "invalid domain");
        const cell = record.cell ?? -1;
        if (!isInteger(cell)) throw new RangeError("cell must be an integer");
        checkId(record.sourceId, "invalid source_id");
        clears.push({ domain: DOMAIN_CODE[record.domain], cell, id: record.sourceId });
      }

      const check = (rc: number) =>
        raiseForCode(rc, rc ? this._raw.swmm_get_last_error_msg(h) : undefined);
      const ptr = (rows: StructValue[], p: number) => (rows.length ? p : 0);
      withStructs(mod, "SWMM_CouplingSource", sources, (src) => {
        if (!this._provider && !boundaries.length && !forcings.length && !clears.length) {
          check(
            solver._operation(() =>
              this._raw.swmm_coupling_set_sources(h, ptr(sources, src), sources.length),
            ),
          );
          return;
        }
        withStructs(mod, "SWMM_CouplingBoundary", boundaries, (bnd) =>
          withStructs(mod, "SWMM_CouplingForcing", forcings, (frc) =>
            withStructs(mod, "SWMM_CouplingClear", clears, (clr) =>
              withStruct(
                mod,
                "SWMM_CouplingFrame",
                (native) =>
                  check(solver._operation(() => this._raw.swmm_coupling_apply_frame(h, native))),
                {
                  struct_size: STRUCTS.SWMM_CouplingFrame.size,
                  version: 1,
                  provider: this._provider,
                  source_count: sources.length,
                  sources: ptr(sources, src),
                  boundary_count: boundaries.length,
                  boundaries: ptr(boundaries, bnd),
                  forcing_count: forcings.length,
                  forcings: ptr(forcings, frc),
                  clear_count: clears.length,
                  clears: ptr(clears, clr),
                },
              ),
            ),
          ),
        );
      });
    } finally {
      for (const p of arrays) mod._free(p);
    }
  }

  /** Step to `seconds` elapsed ({@link Solver.advanceTo}); returns the elapsed seconds reached. */
  advanceTo(seconds: number): number {
    return this._solver.advanceTo(seconds);
  }
}

/** Per-cell values: a scalar for every cell, or one value per listed cell. */
export type PerCell = number | ArrayLike<number>;

/** Options of {@link DomainSources.setSource}. */
export interface SourceOptions {
  /** Source ID (default `"external"`); different IDs add, the same ID replaces. */
  sourceId?: string;
  concentrations?: Readonly<Record<string, PerCell>> | null;
  speciesRates?: Readonly<Record<string, PerCell>> | null;
  heatW?: PerCell;
  /** Elapsed seconds the prescription expires at; `null` holds it. */
  untilSeconds?: number | null;
}

/** Sources, boundaries and receipts of one domain for one provider (Python `DomainSources`). */
export class DomainSources extends SolverView {
  /** The domain these sources address. */
  readonly domain: CouplingDomain;
  /** The provider ID owning the prescriptions (`""`: the default provider). */
  readonly providerId: string;

  /** @internal Obtain through {@link Coupling.surface}, {@link Coupling.groundwater} or `sources`. */
  constructor(owner: Solver, domain: CouplingDomain, provider = "") {
    checkDomain(domain);
    super(owner, true);
    this.domain = domain;
    this.providerId = provider;
  }

  private get _code(): number {
    return DOMAIN_CODE[this.domain];
  }

  private get _species(): string[] {
    return this.domain === "surface"
      ? this._solver.surface2d.species
      : this._solver.groundwater2d.species;
  }

  private _check(rc: number): void {
    raiseForCode(rc, rc ? this._raw.swmm_get_last_error_msg(this._solver.handle) : undefined);
  }

  /** The receipt key of a source ID: provider-owned IDs are namespaced. */
  private _receiptId(sourceId: string): string {
    const name = this.providerId ? `provider/${this.providerId}/${sourceId}` : sourceId;
    checkId(name, "invalid source_id");
    return name;
  }

  /** Gross accepted source inflow and outflow since start, m³. */
  get waterTotals(): CouplingWaterTotals {
    const h = this._h;
    const p = checkedAlloc(this._mod, 16);
    try {
      this._check(
        this._solver._operation(() =>
          this._raw.swmm_coupling_get_water_totals(h, this._code, p, p + 8),
        ),
      );
      return {
        externalIn: this._mod.HEAPF64[p >> 3],
        externalOut: this._mod.HEAPF64[(p >> 3) + 1],
      };
    } finally {
      this._mod._free(p);
    }
  }

  /**
   * Prescribe a source on one or more cells. Each scalar broadcasts to every
   * listed cell; arrays give one rate per cell (not a total to distribute).
   * Omitted species concentrations are zero; set temperature through
   * `__TEMPERATURE__`.
   */
  setSource(
    cells: number | ArrayLike<number>,
    flowM3S: PerCell = 0,
    {
      sourceId = "external",
      concentrations,
      speciesRates,
      heatW = 0,
      untilSeconds = null,
    }: SourceOptions = {},
  ): void {
    void this._h;
    const selected = typeof cells === "number" ? [cells] : Array.from(cells);
    const at = (value: PerCell, i: number): number => {
      if (typeof value === "number") return value;
      if (value.length === 1) return value[0];
      if (value.length !== selected.length) {
        throw new RangeError("per-cell values must match the number of cells");
      }
      return value[i];
    };
    const pick = (values: Readonly<Record<string, PerCell>> | null | undefined, i: number) =>
      Object.fromEntries(Object.entries(values ?? {}).map(([k, v]) => [k, at(v, i)]));
    const records = selected.map((cell, i): RuntimeSource => ({
      sourceId,
      domain: this.domain,
      cell,
      flowM3S: at(flowM3S, i),
      concentrations: pick(concentrations, i),
      speciesRates: pick(speciesRates, i),
      heatW: at(heatW, i),
      untilSeconds,
    }));
    new Coupling(this._solver, this.providerId).setSources(records);
  }

  /** Clear a source ID on every cell, or on one cell. */
  clearSource(sourceId = "external", cell: number | null = null): void {
    if (this.providerId) {
      new Coupling(this._solver, this.providerId).applyFrame({
        clears: [{ sourceId, domain: this.domain, cell: cell ?? -1 }],
      });
      return;
    }
    const h = this._h;
    checkId(sourceId, "invalid source_id");
    if (cell === null) {
      this._check(
        this._solver._operation(() =>
          this._raw.swmm_coupling_clear_source(h, this._code, sourceId),
        ),
      );
    } else {
      if (!isInteger(cell)) throw new RangeError("cell must be an integer");
      this._check(
        this._solver._operation(() =>
          this._raw.swmm_coupling_clear_source_cell(h, this._code, sourceId, cell),
        ),
      );
    }
  }

  /** Cumulative receipt of one source on one cell. */
  sourceReceipt(sourceId = "external", cell = 0): SourceReceipt {
    const h = this._h;
    const id = this._receiptId(sourceId);
    const names = this._species;
    return this._receipts(1, names.length, (out, req, app) =>
      this._raw.swmm_coupling_get_receipt(h, this._code, id, cell, out, req, app, names.length),
    ).map(([row, req, app]) => receiptOf(row, names, req, app, false))[0];
  }

  /** Receipts of one source on several cells, in the given order. */
  sourceReceipts(cells: Iterable<number>, sourceId = "external"): SourceReceipt[] {
    const h = this._h;
    const id = this._receiptId(sourceId);
    const selected = Array.from(cells);
    if (!selected.every(isInteger)) throw new RangeError("cell must be an integer");
    const names = this._species;
    const list = checkedAlloc(this._mod, 4 * Math.max(selected.length, 1));
    try {
      this._mod.HEAP32.set(selected, list >> 2);
      return this._receipts(selected.length, names.length, (out, req, app) =>
        this._raw.swmm_coupling_get_receipts(
          h,
          this._code,
          id,
          list,
          selected.length,
          out,
          req,
          app,
          names.length,
        ),
      ).map(([row, req, app]) => receiptOf(row, names, req, app, false));
    } finally {
      this._mod._free(list);
    }
  }

  /** Run a receipt reader over `count` native receipts with `species` amounts each. */
  private _receipts(
    count: number,
    species: number,
    read: (out: number, requested: number, applied: number) => number,
  ): [Record<string, unknown>, Float64Array, Float64Array][] {
    const mod = this._mod;
    const size = STRUCTS.SWMM_CouplingReceipt.size;
    const amounts = 8 * Math.max(count * species, 1);
    const out = checkedAlloc(mod, size * Math.max(count, 1) + 2 * amounts);
    const req = out + size * Math.max(count, 1);
    const app = req + amounts;
    try {
      mod.HEAPU8.fill(0, out, app + amounts);
      this._check(this._solver._operation(() => read(out, req, app)));
      return Array.from({ length: count }, (_, i) => [
        readStruct(mod, "SWMM_CouplingReceipt", out + i * size),
        mod.HEAPF64.slice((req >> 3) + i * species, (req >> 3) + (i + 1) * species),
        mod.HEAPF64.slice((app >> 3) + i * species, (app >> 3) + (i + 1) * species),
      ]);
    } finally {
      mod._free(out);
    }
  }

  /** Prescribe a runtime edge boundary (`kind` 1 head m, 2 total outward flow m³/s). */
  setBoundary(
    cell: number,
    edge: number,
    kind: number,
    value: number,
    concentrations: Readonly<Record<string, number>> | null = null,
  ): void {
    if (this.providerId) {
      this.setBoundaries([
        { domain: this.domain, cell, edge, kind, value, concentrations: concentrations ?? {} },
      ]);
      return;
    }
    const h = this._h;
    const names = this._species;
    const conc = concentrations ?? {};
    const unknown = Object.keys(conc).filter((k) => !names.includes(k));
    if (unknown.length) {
      throw new RangeError(`Unknown or disabled species: [${unknown.sort().join(", ")}]`);
    }
    const values = checkedAlloc(this._mod, 8 * Math.max(names.length, 1));
    try {
      this._mod.HEAPF64.set(
        names.map((n) => conc[n] ?? 0),
        values >> 3,
      );
      const set =
        this.domain === "groundwater"
          ? this._raw.swmm_gw2d_set_runtime_boundary
          : this._raw.swmm_2d_set_runtime_boundary;
      this._check(
        this._solver._operation(() => set(h, cell, edge, kind, value, values, names.length)),
      );
    } finally {
      this._mod._free(values);
    }
  }

  /** Remove a runtime edge boundary. */
  clearBoundary(cell: number, edge: number): void {
    if (this.providerId || this.domain === "surface") {
      this.setBoundaries([{ domain: this.domain, cell, edge, kind: 0 }]);
      return;
    }
    const h = this._h;
    this._check(
      this._solver._operation(() => this._raw.swmm_gw2d_clear_runtime_boundary(h, cell, edge)),
    );
  }

  /** Last accepted outward m³/s through a groundwater runtime boundary (zero when none). */
  boundaryFlow(cell: number, edge: number): number {
    if (this.domain !== "groundwater") throw new RangeError("use surface boundary_flow");
    const h = this._h;
    const p = checkedAlloc(this._mod, 8);
    try {
      this._check(
        this._solver._operation(() =>
          this._raw.swmm_gw2d_get_runtime_boundary_flow(h, cell, edge, p),
        ),
      );
      return this._mod.HEAPF64[p >> 3];
    } finally {
      this._mod._free(p);
    }
  }

  /** Apply runtime boundaries of this domain as one frame. */
  setBoundaries(records: Iterable<RuntimeBoundary>): void {
    const list = Array.from(records);
    if (list.some((r) => r.domain !== this.domain)) {
      throw new RangeError("boundary domain mismatch");
    }
    new Coupling(this._solver, this.providerId).applyFrame({ boundaries: list });
  }

  /** Apply surface forcing records as one frame. */
  setForcings(records: Iterable<RuntimeForcing>): void {
    if (this.domain !== "surface") throw new RangeError("forcing addresses surface cells");
    new Coupling(this._solver, this.providerId).applyFrame({ forcings: Array.from(records) });
  }

  /** Cumulative transfer through a boundary edge, positive inward. */
  boundaryReceipt(cell: number, edge: number): BoundaryReceipt {
    return this._transferReceipt(cell, edge, false);
  }

  /** Cumulative paired infiltration of a surface cell. */
  infiltrationReceipt(cell: number): BoundaryReceipt {
    if (this.domain !== "surface") {
      throw new RangeError("infiltration receipts use surface species");
    }
    return this._transferReceipt(cell, 0, true);
  }

  private _transferReceipt(cell: number, edge: number, infiltration: boolean): BoundaryReceipt {
    const h = this._h;
    const names = this._species;
    return this._receipts(1, names.length, (out, req, app) =>
      infiltration
        ? this._raw.swmm_coupling_get_infiltration_receipt(h, cell, out, req, app, names.length)
        : this._raw.swmm_coupling_get_boundary_receipt(
            h,
            this._code,
            cell,
            edge,
            out,
            req,
            app,
            names.length,
          ),
    ).map(([row, req, app]) => receiptOf(row, names, req, app, true))[0];
  }

  /** Every surface ledger term of one species, in its mass units. */
  speciesLedger(species: string): SurfaceSpeciesLedger {
    if (this.domain !== "surface") throw new RangeError("surface ledger only");
    const h = this._h;
    const row = this._solver.surface2d.species.indexOf(species);
    if (row < 0) throw new RangeError(`${JSON.stringify(species)} is not a surface species`);
    const p = checkedAlloc(this._mod, 8);
    try {
      const out = {} as SurfaceSpeciesLedger;
      LEDGER_TERMS.forEach((key, term) => {
        this._check(
          this._solver._operation(() => this._raw.swmm_2d_get_species_ledger(h, row, term, p)),
        );
        out[key] = this._mod.HEAPF64[p >> 3];
      });
      return out;
    } finally {
      this._mod._free(p);
    }
  }
}
