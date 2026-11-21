/**
 * @file XSectionGeometry.ts
 * @brief Cross-section hydraulic geometry (Python `openswmm.engine._xsect`).
 *
 * The engine's cross-section kernels as a standalone object: the same code the
 * routing uses, so results agree with a simulation exactly. Build one from
 * shape parameters with no model, or take a link's geometry with
 * {@link XSectionGeometry.fromLink} (a deep copy that outlives the solver).
 *
 * Every query takes a number (returns a number) or an array (returns a
 * `Float64Array`), one C call either way. Values are in the section's units:
 * ft for `"US"`, m for `"SI"`; {@link XSectionGeometry.criticalDepth} takes a
 * flow in {@link XSectionGeometry.flowUnits}.
 *
 * A section owns a native handle: call {@link XSectionGeometry.destroy} (or
 * use `using`) when done. A finalizer frees forgotten handles, but its timing
 * is up to the garbage collector.
 *
 * @license  Apache-2.0
 */

import { XSectShape } from "./enums.js";
import { BadParamError, raiseForCode, StaleObjectError } from "./errors.js";
import { checkedAlloc, rawOf } from "./mem.js";
import type { Link } from "./Links.js";
import type { RawApi } from "./raw.js";
import type { OpenSwmmWasmModule } from "./types.js";

/** Unit system of a section: lengths in ft (`"US"`) or m (`"SI"`). */
export type XSectUnits = "US" | "SI";

const FLOW_UNIT_NAMES = ["CFS", "GPM", "MGD", "CMS", "LPS", "MLD"] as const;

type Scalar = (h: number, v: number, out: number) => number;
type Batch = (h: number, inp: number, n: number, out: number) => number;

const freeHandle = new FinalizationRegistry<{ raw: RawApi; handle: number }>(
  ({ raw, handle }) => void raw.swmm_xsect_free(handle),
);

function unitsCode(units: XSectUnits): number {
  const u = typeof units === "string" ? units.trim().toUpperCase() : units;
  if (u === "US") return 0;
  if (u === "SI") return 1;
  throw new BadParamError(`units must be 'US' or 'SI', got ${JSON.stringify(units)}`);
}

function finiteArray(values: ArrayLike<number>, name: string): Float64Array {
  const arr = Float64Array.from(values);
  if (!arr.every(Number.isFinite))
    throw new BadParamError(`${name} must contain only finite values`);
  return arr;
}

/** Name of a cross-section shape code, e.g. `"CIRCULAR"`. */
export function shapeName(mod: OpenSwmmWasmModule, shape: XSectShape | number): string {
  const name = rawOf(mod).swmm_xsect_shape_name(shape);
  if (!name) throw new BadParamError(`${shape} is not a valid cross-section shape code`);
  return name;
}

/** A cross-section that can be queried for its hydraulic geometry. */
export class XSectionGeometry {
  /** @internal */
  private readonly _mod: OpenSwmmWasmModule;
  /** @internal */
  private readonly _raw: RawApi;
  /** @internal */
  private _handle: number;

  /** Shape of this section ({@link XSectShape}). */
  readonly shape: XSectShape;

  /**
   * Build a section from a shape code and its parameters.
   *
   * @param geom  `geom1`, or `[geom1, geom2?, geom3?, geom4?]` (missing ones are 0).
   * @param units `"US"` or `"SI"`. Required: there is no default, because an
   *   assumed unit system silently gives wrong answers.
   * @throws BadParamError when the shape or parameters are invalid (IRREGULAR,
   *   CUSTOM and STREET_XSECT need {@link fromTransect}, {@link fromCurve} or
   *   {@link fromStreet}).
   */
  constructor(
    mod: OpenSwmmWasmModule,
    shape: XSectShape | number,
    geom: number | readonly number[],
    { units }: { units: XSectUnits },
  ) {
    const raw = rawOf(mod);
    const us = unitsCode(units);
    const [geom1, geom2 = 0, geom3 = 0, geom4 = 0] = typeof geom === "number" ? [geom] : geom;
    const handle = XSectionGeometry._create(mod, (out) =>
      raw.swmm_xsect_create(shape, geom1, geom2, geom3, geom4, us, out),
    );
    if (!handle) {
      const label = raw.swmm_xsect_shape_name(shape) || `<unknown shape ${shape}>`;
      throw new BadParamError(
        `cannot build a ${label} cross-section from geom=(${geom1}, ${geom2}, ${geom3}, ${geom4}) in '${units}' units`,
      );
    }
    this._mod = mod;
    this._raw = raw;
    this._handle = handle;
    this.shape = shape;
    freeHandle.register(this, { raw, handle }, this);
  }

  /** @internal Run a `SWMM_XSect*` constructor; 0 when it fails. */
  private static _create(mod: OpenSwmmWasmModule, call: (out: number) => number): number {
    const out = checkedAlloc(mod, 4);
    try {
      mod.HEAPU32[out >> 2] = 0;
      return call(out) === 0 ? mod.HEAPU32[out >> 2] : 0;
    } finally {
      mod._free(out);
    }
  }

  /** @internal Adopt a handle built by another constructor. */
  private static _adopt(mod: OpenSwmmWasmModule, handle: number): XSectionGeometry {
    const self = Object.create(XSectionGeometry.prototype) as XSectionGeometry;
    const raw = rawOf(mod);
    const shape = (() => {
      const p = checkedAlloc(mod, 4);
      try {
        raiseForCode(raw.swmm_xsect_get_shape(handle, p));
        return mod.HEAP32[p >> 2];
      } finally {
        mod._free(p);
      }
    })();
    Object.assign(self, { _mod: mod, _raw: raw, _handle: handle, shape });
    freeHandle.register(self, { raw, handle }, self);
    return self;
  }

  /** @internal Copy arrays into one heap block and call `fn(ptr_0, ptr_1, ...)`. */
  private static _withArrays<T>(
    mod: OpenSwmmWasmModule,
    arrays: Float64Array[],
    fn: (ptrs: number[]) => T,
  ): T {
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const block = checkedAlloc(mod, 8 * Math.max(total, 1));
    try {
      let at = block;
      const ptrs = arrays.map((a) => {
        mod.HEAPF64.set(a, at >> 3);
        const p = at;
        at += 8 * a.length;
        return p;
      });
      return fn(ptrs);
    } finally {
      mod._free(block);
    }
  }

  /**
   * An irregular (natural channel) section from transect data, as a
   * `[TRANSECTS]` entry. Overbank roughness 0 means `nChannel`; the roughness
   * values weight the hydraulic-radius table, so they change {@link hydRadius}.
   */
  static fromTransect(
    mod: OpenSwmmWasmModule,
    stations: ArrayLike<number>,
    elevations: ArrayLike<number>,
    opts: {
      leftBank: number;
      rightBank: number;
      nChannel: number;
      nLeft?: number;
      nRight?: number;
      lengthFactor?: number;
      units: XSectUnits;
    },
  ): XSectionGeometry {
    const us = unitsCode(opts.units);
    const st = finiteArray(stations, "stations");
    const el = finiteArray(elevations, "elevations");
    if (st.length !== el.length) {
      throw new BadParamError(
        `stations (${st.length}) and elevations (${el.length}) must have the same length`,
      );
    }
    if (st.length < 2)
      throw new BadParamError("a transect needs at least 2 station/elevation pairs");
    const raw = rawOf(mod);
    const handle = XSectionGeometry._withArrays(mod, [st, el], ([s, e]) =>
      XSectionGeometry._create(mod, (out) =>
        raw.swmm_xsect_create_irregular(
          s,
          e,
          st.length,
          opts.leftBank,
          opts.rightBank,
          opts.nLeft ?? 0,
          opts.nChannel,
          opts.nRight ?? 0,
          opts.lengthFactor ?? 1,
          us,
          out,
        ),
      ),
    );
    if (!handle) {
      throw new BadParamError(
        "cannot build an irregular cross-section from the given transect (nChannel must be > 0 " +
          "and the stations must enclose a wetted area)",
      );
    }
    return XSectionGeometry._adopt(mod, handle);
  }

  /** A custom section from a normalized shape curve scaled to `fullDepth` (a SHAPE curve). */
  static fromCurve(
    mod: OpenSwmmWasmModule,
    fullDepth: number,
    curveDepths: ArrayLike<number>,
    curveWidths: ArrayLike<number>,
    { units }: { units: XSectUnits },
  ): XSectionGeometry {
    const us = unitsCode(units);
    const cx = finiteArray(curveDepths, "curveDepths");
    const cy = finiteArray(curveWidths, "curveWidths");
    if (cx.length !== cy.length) {
      throw new BadParamError(
        `curveDepths (${cx.length}) and curveWidths (${cy.length}) must have the same length`,
      );
    }
    if (cx.length < 2) throw new BadParamError("a shape curve needs at least 2 points");
    const raw = rawOf(mod);
    const handle = XSectionGeometry._withArrays(mod, [cx, cy], ([d, w]) =>
      XSectionGeometry._create(mod, (out) =>
        raw.swmm_xsect_create_custom(fullDepth, d, w, cx.length, us, out),
      ),
    );
    if (!handle) {
      throw new BadParamError(
        `cannot build a custom cross-section with fullDepth=${fullDepth} from the given shape curve`,
      );
    }
    return XSectionGeometry._adopt(mod, handle);
  }

  /** A street section, as a `[STREETS]` entry (`sides`: 1 = half, 2 = full street). */
  static fromStreet(
    mod: OpenSwmmWasmModule,
    width: number,
    curbHeight: number,
    slope: number,
    roughness: number,
    opts: {
      gutterDepression?: number;
      gutterWidth?: number;
      sides?: number;
      backWidth?: number;
      backSlope?: number;
      backRoughness?: number;
      units: XSectUnits;
    },
  ): XSectionGeometry {
    const us = unitsCode(opts.units);
    const raw = rawOf(mod);
    const handle = XSectionGeometry._create(mod, (out) =>
      raw.swmm_xsect_create_street(
        width,
        curbHeight,
        slope,
        roughness,
        opts.gutterDepression ?? 0,
        opts.gutterWidth ?? 0,
        opts.sides ?? 2,
        opts.backWidth ?? 0,
        opts.backSlope ?? 0,
        opts.backRoughness ?? 0,
        us,
        out,
      ),
    );
    if (!handle) {
      throw new BadParamError(
        "cannot build a street cross-section (width, curbHeight and roughness must be > 0 and " +
          "sides must be 1 or 2)",
      );
    }
    return XSectionGeometry._adopt(mod, handle);
  }

  /**
   * The geometry the engine built for a link of an open model, deep-copied
   * so it stays valid after the solver closes; in the model's units.
   *
   * @throws LifecycleError while the model is still being built.
   * @throws BadParamError when the link has no cross-section (e.g. a pump).
   * @throws StaleObjectError when `link` predates a change to the model.
   */
  static fromLink(link: Link): XSectionGeometry {
    const [mod, handle] = link._newXsectHandle();
    return XSectionGeometry._adopt(mod, handle);
  }

  /** Free the native section. Further queries throw. */
  destroy(): void {
    if (this._handle) {
      freeHandle.unregister(this);
      this._raw.swmm_xsect_free(this._handle);
      this._handle = 0;
    }
  }

  [Symbol.dispose](): void {
    this.destroy();
  }

  /** @internal */
  private get _h(): number {
    if (!this._handle) throw new StaleObjectError("XSectionGeometry has been destroyed");
    return this._handle;
  }

  /** @internal Scalar in, scalar out; array in, `Float64Array` out. */
  private _eval(scalar: Scalar, batch: Batch, values: number | ArrayLike<number>, name: string) {
    const h = this._h;
    const mod = this._mod;
    if (typeof values === "number") {
      const out = checkedAlloc(mod, 8);
      try {
        if (scalar(h, values, out) !== 0) {
          throw new BadParamError(
            `${name} ${values} is out of range for this section (must be a finite, non-negative number)`,
          );
        }
        return mod.HEAPF64[out >> 3];
      } finally {
        mod._free(out);
      }
    }
    const input = Float64Array.from(values);
    if (input.length === 0) return new Float64Array(0);
    const block = checkedAlloc(mod, 16 * input.length);
    try {
      mod.HEAPF64.set(input, block >> 3);
      const out = block + 8 * input.length;
      if (batch(h, block, input.length, out) !== 0) {
        throw new BadParamError(
          `${name} array contains a value out of range for this section (values must be finite and non-negative)`,
        );
      }
      return mod.HEAPF64.slice(out >> 3, (out >> 3) + input.length);
    } finally {
      mod._free(block);
    }
  }

  /** Flow area at `depth`. */
  area(depth: number): number;
  area(depth: ArrayLike<number>): Float64Array;
  area(depth: number | ArrayLike<number>): number | Float64Array {
    const r = this._raw;
    return this._eval(r.swmm_xsect_area_of_depth, r.swmm_xsect_area_of_depth_array, depth, "depth");
  }

  /** Top width of the water surface at `depth`. */
  width(depth: number): number;
  width(depth: ArrayLike<number>): Float64Array;
  width(depth: number | ArrayLike<number>): number | Float64Array {
    const r = this._raw;
    return this._eval(
      r.swmm_xsect_width_of_depth,
      r.swmm_xsect_width_of_depth_array,
      depth,
      "depth",
    );
  }

  /** Hydraulic radius (area / wetted perimeter) at `depth`. */
  hydRadius(depth: number): number;
  hydRadius(depth: ArrayLike<number>): Float64Array;
  hydRadius(depth: number | ArrayLike<number>): number | Float64Array {
    const r = this._raw;
    return this._eval(
      r.swmm_xsect_hydrad_of_depth,
      r.swmm_xsect_hydrad_of_depth_array,
      depth,
      "depth",
    );
  }

  /** Depth of flow for `area`, the inverse of {@link XSectionGeometry.area}. */
  depthFromArea(area: number): number;
  depthFromArea(area: ArrayLike<number>): Float64Array;
  depthFromArea(area: number | ArrayLike<number>): number | Float64Array {
    const r = this._raw;
    return this._eval(r.swmm_xsect_depth_of_area, r.swmm_xsect_depth_of_area_array, area, "area");
  }

  /** Hydraulic radius for `area`. */
  hydRadiusFromArea(area: number): number;
  hydRadiusFromArea(area: ArrayLike<number>): Float64Array;
  hydRadiusFromArea(area: number | ArrayLike<number>): number | Float64Array {
    const r = this._raw;
    return this._eval(r.swmm_xsect_hydrad_of_area, r.swmm_xsect_hydrad_of_area_array, area, "area");
  }

  /** Section factor A·R^(2/3) for `area`. */
  sectionFactor(area: number): number;
  sectionFactor(area: ArrayLike<number>): Float64Array;
  sectionFactor(area: number | ArrayLike<number>): number | Float64Array {
    const r = this._raw;
    return this._eval(
      r.swmm_xsect_sectfactor_of_area,
      r.swmm_xsect_sectfactor_of_area_array,
      area,
      "area",
    );
  }

  /** Flow area for section factor `sf` (used to solve for normal depth). */
  areaFromSectionFactor(sf: number): number;
  areaFromSectionFactor(sf: ArrayLike<number>): Float64Array;
  areaFromSectionFactor(sf: number | ArrayLike<number>): number | Float64Array {
    const r = this._raw;
    return this._eval(
      r.swmm_xsect_area_of_sectfactor,
      r.swmm_xsect_area_of_sectfactor_array,
      sf,
      "section factor",
    );
  }

  /** dS/dA, the derivative of the section factor with respect to area. */
  dsda(area: number): number;
  dsda(area: ArrayLike<number>): Float64Array;
  dsda(area: number | ArrayLike<number>): number | Float64Array {
    const r = this._raw;
    return this._eval(r.swmm_xsect_dsda, r.swmm_xsect_dsda_array, area, "area");
  }

  /** Critical depth for `flow`, in {@link flowUnits}. */
  criticalDepth(flow: number): number;
  criticalDepth(flow: ArrayLike<number>): Float64Array;
  criticalDepth(flow: number | ArrayLike<number>): number | Float64Array {
    const r = this._raw;
    return this._eval(r.swmm_xsect_critical_depth, r.swmm_xsect_critical_depth_array, flow, "flow");
  }

  /** @internal `[unit system, flow units]` codes. */
  private _units(): [number, number] {
    const p = checkedAlloc(this._mod, 8);
    try {
      raiseForCode(this._raw.swmm_xsect_get_units(this._h, p, p + 4));
      return [this._mod.HEAP32[p >> 2], this._mod.HEAP32[(p >> 2) + 1]];
    } finally {
      this._mod._free(p);
    }
  }

  /** `"US"` or `"SI"`, the unit system of every value here. */
  get units(): XSectUnits {
    return this._units()[0] === 1 ? "SI" : "US";
  }

  /** Flow units of {@link criticalDepth}: `"CFS"`, `"CMS"`, ... */
  get flowUnits(): string {
    return FLOW_UNIT_NAMES[this._units()[1]];
  }

  /** @internal `[yFull, aFull, rFull, wMax, sFull, aMax]`. */
  private _full(): number[] {
    const p = checkedAlloc(this._mod, 48);
    try {
      raiseForCode(
        this._raw.swmm_xsect_full_properties(this._h, p, p + 8, p + 16, p + 24, p + 32, p + 40),
      );
      return Array.from(this._mod.HEAPF64.subarray(p >> 3, (p >> 3) + 6));
    } finally {
      this._mod._free(p);
    }
  }

  /** Depth at which the section is full. */
  get fullDepth(): number {
    return this._full()[0];
  }

  /** Flow area when full. */
  get fullArea(): number {
    return this._full()[1];
  }

  /** Hydraulic radius when full. */
  get fullHydRadius(): number {
    return this._full()[2];
  }

  /** Width at the widest point. */
  get maxWidth(): number {
    return this._full()[3];
  }

  /** Section factor when full. */
  get fullSectionFactor(): number {
    return this._full()[4];
  }

  /** Area at which the flow is a maximum. */
  get maxArea(): number {
    return this._full()[5];
  }

  /** True when the section is open to the atmosphere. */
  get isOpen(): boolean {
    const p = checkedAlloc(this._mod, 4);
    try {
      raiseForCode(this._raw.swmm_xsect_is_open(this._h, p));
      return this._mod.HEAP32[p >> 2] !== 0;
    } finally {
      this._mod._free(p);
    }
  }
}
