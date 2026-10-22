/** ARD authoring configuration. Register a process component/config file for persistence. */
import { TransportDispersionMode } from "./enums.js";
import type { OpenSwmmWasmModule } from "./types.js";
import type { RawApi } from "./raw.js";
import { guardedRaw, withCStrings, withDouble, withInt } from "./mem.js";
import { raiseForCode } from "./errors.js";

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
    const p = this.mod._malloc(16);
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
  get boundaries(): readonly TransportRow[] {
    return this.rows(false);
  }
  get sources(): readonly TransportRow[] {
    return this.rows(true);
  }
  private rows(source: boolean): TransportRow[] {
    const count = withInt(this.mod, (p) =>
      source
        ? this.raw.swmm_transport_source_count(this.handle, p)
        : this.raw.swmm_transport_boundary_count(this.handle, p),
    );
    const read = source ? this.raw.swmm_transport_get_source : this.raw.swmm_transport_get_boundary;
    const p = this.mod._malloc(16);
    if (!p) throw new RangeError("Cannot allocate transport row buffer");
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
