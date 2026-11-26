/**
 * @file Transport.ts
 * @brief ARD transport configuration and engine capability snapshots (Python
 *        `openswmm.engine._transport`). Dispersion is in project length² per
 *        second, target spacing in project length. Register a process
 *        component/config file for persistence.
 *
 * @license  Apache-2.0
 */
import {
  TransportClass,
  TransportDispersionMode,
  TransportDomain,
  type TransportState,
} from "./enums.js";
import type { OpenSwmmWasmModule } from "./types.js";
import { STRUCTS, type RawApi } from "./raw.js";
import {
  checkedAlloc,
  guardedRaw,
  rawOf,
  withCString,
  withCStrings,
  withDouble,
  withInt,
} from "./mem.js";
import { raiseForCode } from "./errors.js";
import { readStruct, withStruct, withStructs } from "./structs.js";
import type { Solver } from "./Solver.js";

/** Hardware and OpenMP limits; zero means unknown or not initialized. */
export interface ThreadInfo {
  readonly logicalCpus: number;
  readonly ompMaxThreads: number;
  readonly ompAvailable: boolean;
  readonly perfCores: number;
  readonly kokkosOmpThreads: number;
}

/** Thread team sizes resolved for a model. */
export interface EffectiveThreads {
  readonly globalThreads: number;
  readonly dynamicWave: number;
  readonly surface2d: number;
}

/** One domain × species-class entry of a transport capability matrix. */
export class TransportCell {
  constructor(
    readonly state: TransportState,
    /** Rows of this class carried in the domain (0 unless ENABLED). */
    readonly count: number,
    /** Key or explanation; `""` when ENABLED. */
    readonly reason: string,
  ) {
    Object.freeze(this);
  }
}

/** Capability matrix keyed by domain, then species class. */
export type TransportMatrix = Map<TransportDomain, Map<TransportClass, TransportCell>>;

function readMatrix(mod: OpenSwmmWasmModule, ptr: number): TransportMatrix {
  const cellSize = STRUCTS.SWMM_TransportCell.size;
  const matrix: TransportMatrix = new Map();
  for (let d = 0; d < 4; d++) {
    const row = new Map<TransportClass, TransportCell>();
    for (let c = 0; c < 4; c++) {
      const cell = readStruct(mod, "SWMM_TransportCell", ptr + (d * 4 + c) * cellSize) as {
        state: number;
        count: number;
        reason: string;
      };
      row.set(c as TransportClass, new TransportCell(cell.state, cell.count, cell.reason));
    }
    matrix.set(d as TransportDomain, row);
  }
  return matrix;
}

/** Process-wide hardware and OpenMP limits (Python `thread_info`). */
export function threadInfo(mod: OpenSwmmWasmModule): ThreadInfo {
  return withStruct(mod, "SWMM_ThreadInfo", (p) => {
    raiseForCode(rawOf(mod).swmm_get_thread_info(p));
    const r = readStruct(mod, "SWMM_ThreadInfo", p) as Record<string, number>;
    return {
      logicalCpus: r.logical_cpus,
      ompMaxThreads: r.omp_max_threads,
      ompAvailable: r.omp_available !== 0,
      perfCores: r.perf_cores,
      kokkosOmpThreads: r.kokkos_omp_threads,
    };
  });
}

/** Thread teams for a model; `requested = 0` selects automatic (Python `effective_threads`). */
export function effectiveThreads(owner: Solver, requested = 0): EffectiveThreads {
  const mod = owner.module;
  const p = checkedAlloc(mod, 12);
  try {
    mod.HEAP32.fill(0, p >> 2, (p >> 2) + 3);
    raiseForCode(rawOf(mod).swmm_get_effective_threads(owner.handle, requested, p, p + 4, p + 8));
    const h = mod.HEAP32;
    return { globalThreads: h[p >> 2], dynamicWave: h[(p >> 2) + 1], surface2d: h[(p >> 2) + 2] };
  } finally {
    mod._free(p);
  }
}

/**
 * Fresh capability matrix (Python `transport_matrix`). Read after open and
 * after option changes; unavailable entries carry a reason.
 */
export function transportMatrix(owner: Solver): TransportMatrix {
  const mod = owner.module;
  return withStruct(mod, "SWMM_TransportMatrix", (p) => {
    raiseForCode(rawOf(mod).swmm_get_transport_matrix(owner.handle, p));
    return readMatrix(mod, p);
  });
}

/** Native display label of a {@link TransportDomain}. */
export function transportDomainName(mod: OpenSwmmWasmModule, domain: TransportDomain): string {
  if (!(domain in TransportDomain))
    throw new RangeError(`${domain} is not a valid TransportDomain`);
  return rawOf(mod).swmm_transport_domain_name(domain) ?? "";
}

/** Native display label of a {@link TransportClass}. */
export function transportClassName(mod: OpenSwmmWasmModule, speciesClass: TransportClass): string {
  if (!(speciesClass in TransportClass)) {
    throw new RangeError(`${speciesClass} is not a valid TransportClass`);
  }
  return rawOf(mod).swmm_transport_class_name(speciesClass) ?? "";
}

/** Draft of {@link Transport.previewMatrix}; booleans accept 0/1 as in Python. */
export interface TransportDraft {
  ignoreQuality: boolean | number;
  heat: boolean | number;
  age: boolean | number;
  ignore2d: boolean | number;
  /** POLLUTANTS, MSX, AGE, TEMPERATURE. */
  surfaceClasses: readonly [boolean | number, boolean | number, boolean | number, boolean | number];
  /** -1 automatic (default), 0 off, 1 on. */
  groundwater?: number;
}

export interface TransportRow {
  readonly element: string;
  readonly species: string;
  readonly isTimeseries: boolean;
  readonly value: number;
  readonly timeseries: string;
}
export interface ConduitDispersion {
  readonly linkIndex: number;
  readonly value: number;
}

/** `solver.transport` configuration, with read-only authored rows. */
export class Transport {
  private readonly raw: RawApi;
  constructor(
    private readonly mod: OpenSwmmWasmModule,
    private readonly handle: number,
    checkOwner: () => void = () => {},
  ) {
    this.raw = guardedRaw(mod, checkOwner);
  }
  get configured(): boolean {
    return Boolean(
      withInt(this.mod, (p) => this.raw.swmm_transport_get_configured(this.handle, p)),
    );
  }
  get dispersionMode(): TransportDispersionMode {
    return withInt(this.mod, (p) => this.raw.swmm_transport_get_dispersion_mode(this.handle, p));
  }
  set dispersionMode(value: TransportDispersionMode) {
    raiseForCode(this.raw.swmm_transport_set_dispersion_mode(this.handle, value));
  }
  /** Coefficient in display units (ft²/s or m²/s). */
  get dispersionValue(): number {
    return withDouble(this.mod, (p) =>
      this.raw.swmm_transport_get_dispersion_value(this.handle, p),
    );
  }
  set dispersionValue(value: number) {
    raiseForCode(this.raw.swmm_transport_set_dispersion_value(this.handle, value));
  }
  /** Target spacing in display length units; zero selects the engine default. */
  get targetDx(): number {
    return withDouble(this.mod, (p) => this.raw.swmm_transport_get_target_dx(this.handle, p));
  }
  set targetDx(value: number) {
    raiseForCode(this.raw.swmm_transport_set_target_dx(this.handle, value));
  }
  get conduitDispersion(): readonly ConduitDispersion[] {
    const count = withInt(this.mod, (p) =>
      this.raw.swmm_transport_conduit_disp_count(this.handle, p),
    );
    const p = checkedAlloc(this.mod, 16);
    try {
      return Array.from({ length: count }, (_, i) => {
        raiseForCode(this.raw.swmm_transport_get_conduit_disp(this.handle, i, p, p + 8));
        return {
          linkIndex: this.mod.getValue(p, "i32"),
          value: this.mod.getValue(p + 8, "double"),
        };
      });
    } finally {
      this.mod._free(p);
    }
  }
  /** Authored rows; `value` is a concentration in species units (or read `timeseries`). */
  get boundaries(): readonly TransportRow[] {
    return this.rows(false);
  }
  /** Authored rows; `value` is a mass rate in species mass units per second. */
  get sources(): readonly TransportRow[] {
    return this.rows(true);
  }

  /**
   * Plan transport for a draft without changing the open model; same shape
   * as {@link transportMatrix}. Planned transport, not runtime activity.
   */
  previewMatrix({
    ignoreQuality,
    heat,
    age,
    ignore2d,
    surfaceClasses,
    groundwater = -1,
  }: TransportDraft): TransportMatrix {
    const flag = (v: boolean | number) => (typeof v === "boolean" ? (v ? 1 : 0) : Math.trunc(v));
    if (surfaceClasses.length !== 4) throw new RangeError("surface_classes must have four entries");
    const draft = {
      ignore_quality: flag(ignoreQuality),
      heat: flag(heat),
      age: flag(age),
      ignore_2d: flag(ignore2d),
      surface_class: surfaceClasses.map(flag),
      groundwater: Math.trunc(groundwater),
    };
    return withStructs(this.mod, "SWMM_TransportDraft", [draft], (dp) =>
      withStruct(this.mod, "SWMM_TransportMatrix", (mp) => {
        raiseForCode(this.raw.swmm_preview_transport_matrix(this.handle, dp, mp));
        return readMatrix(this.mod, mp);
      }),
    );
  }

  /** `[TRANSPORT_OPTIONS] DETAILED_OUTPUT` path (`""` when off). */
  get detailedOutput(): string {
    return withCString(this.mod, 256, (buf, len) =>
      this.raw.swmm_transport_get_detailed_output(this.handle, buf, len),
    );
  }
  set detailedOutput(value: string | null) {
    raiseForCode(this.raw.swmm_transport_set_detailed_output(this.handle, value ?? ""));
  }

  /** Add or replace a conduit's dispersion override (display length²/s, >= 0). */
  setConduitDispersion(linkIndex: number, value: number): void {
    raiseForCode(this.raw.swmm_transport_set_conduit_disp(this.handle, linkIndex, value));
  }

  /** Remove the `[CONDUIT_DISPERSION]` row at `index`. */
  removeConduitDispersion(index: number): void {
    raiseForCode(this.raw.swmm_transport_remove_conduit_disp(this.handle, index));
  }

  /** Add or replace a boundary row for node `element`: a concentration or a time series. */
  setBoundary(element: string, species: string, value = 0, timeseries: string | null = null): void {
    raiseForCode(
      this.raw.swmm_transport_set_boundary(
        this.handle,
        element,
        species,
        timeseries ? 1 : 0,
        value,
        timeseries ?? "",
      ),
    );
  }

  /** Remove the `[TRANSPORT_BOUNDARIES]` row at `index`. */
  removeBoundary(index: number): void {
    raiseForCode(this.raw.swmm_transport_remove_boundary(this.handle, index));
  }

  /**
   * Add or replace a distributed source on conduit `element`: a mass rate
   * (negative extracts) or a time series.
   */
  setSource(element: string, species: string, value = 0, timeseries: string | null = null): void {
    raiseForCode(
      this.raw.swmm_transport_set_source(
        this.handle,
        element,
        species,
        timeseries ? 1 : 0,
        value,
        timeseries ?? "",
      ),
    );
  }

  /** Remove the `[TRANSPORT_SOURCES]` row at `index`. */
  removeSource(index: number): void {
    raiseForCode(this.raw.swmm_transport_remove_source(this.handle, index));
  }
  private rows(source: boolean): TransportRow[] {
    const count = withInt(this.mod, (p) =>
      source
        ? this.raw.swmm_transport_source_count(this.handle, p)
        : this.raw.swmm_transport_boundary_count(this.handle, p),
    );
    const read = source ? this.raw.swmm_transport_get_source : this.raw.swmm_transport_get_boundary;
    const p = checkedAlloc(this.mod, 16);
    try {
      return Array.from({ length: count }, (_, i) => {
        const [element, species, timeseries] = withCStrings(
          this.mod,
          1024,
          3,
          ([elementBuf, speciesBuf, timeseriesBuf], size) =>
            read(this.handle, i, elementBuf, size, speciesBuf, size, p, p + 8, timeseriesBuf, size),
        );
        return {
          element,
          species,
          isTimeseries: Boolean(this.mod.getValue(p, "i32")),
          value: this.mod.getValue(p + 8, "double"),
          timeseries,
        };
      });
    } finally {
      this.mod._free(p);
    }
  }
}
