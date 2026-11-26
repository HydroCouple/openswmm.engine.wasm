/**
 * Wave A1: pure-TypeScript mirrors of Python's `_dates`, `_geometry` and
 * `GeoPackageError` (no WASM module needed).
 */
import { describe, it, expect } from "vitest";
import {
  CrossSection,
  EngineError,
  ErrorCode,
  GeoPackageError,
  XSectShape,
  datetimeToOadate,
  oadateToDatetime,
} from "../src/js/index.js";

describe("oadateToDatetime / datetimeToOadate", () => {
  it("0 is 1899-12-30 00:00 UTC and noon is 0.5", () => {
    expect(oadateToDatetime(0).toISOString()).toBe("1899-12-30T00:00:00.000Z");
    expect(oadateToDatetime(0.5).toISOString()).toBe("1899-12-30T12:00:00.000Z");
  });

  it("keeps the floor-day convention before the epoch, as Python does", () => {
    // -0.75 = day -1 (1899-12-29) + 0.25 of a day.
    expect(oadateToDatetime(-0.75).toISOString()).toBe("1899-12-29T06:00:00.000Z");
    expect(datetimeToOadate(new Date(Date.UTC(1899, 11, 29, 6)))).toBe(-0.75);
  });

  it("rounds to the millisecond and never rolls into the next day", () => {
    const d = new Date(Date.UTC(2026, 10, 17, 13, 45, 30, 250));
    expect(oadateToDatetime(datetimeToOadate(d)).getTime()).toBe(d.getTime());
    expect(oadateToDatetime(1 - 1e-12).toISOString()).toBe("1899-12-30T23:59:59.999Z");
  });
});

describe("CrossSection", () => {
  it("names the shape and labels only the parameters the shape uses", () => {
    const xs = CrossSection.fromRaw(XSectShape.CIRCULAR, 1.2, 0, 0, 0);
    expect(xs.shapeName).toBe("CIRCULAR");
    expect(xs.geomLabels).toEqual({ diameter: 1.2 });
    const trap = CrossSection.fromRaw(XSectShape.TRAPEZOIDAL, 2, 3, 0.5, 1);
    expect(trap.geomLabels).toEqual({
      height: 2,
      bottom_width: 3,
      left_slope: 0.5,
      right_slope: 1,
    });
    expect(CrossSection.fromRaw(XSectShape.DUMMY, 0, 0, 0, 0).geomLabels).toEqual({});
  });

  it("falls back to generic labels and an UNKNOWN name for unknown codes", () => {
    const xs = CrossSection.fromRaw(99, 1, 2, 3, 4);
    expect(xs.shapeName).toBe("UNKNOWN(99)");
    expect(xs.geomLabels).toEqual({ geom1: 1, geom2: 2, geom3: 3, geom4: 4 });
  });

  it("is immutable", () => {
    const xs = CrossSection.fromRaw(XSectShape.CIRCULAR, 1, 0, 0, 0);
    expect(Object.isFrozen(xs)).toBe(true);
  });
});

describe("GeoPackageError", () => {
  it("is an EngineError carrying SWMM_ERR_IO and the library's reason", () => {
    const e = new GeoPackageError("no such table: gpkg_contents");
    expect(e).toBeInstanceOf(EngineError);
    expect(e.code).toBe(ErrorCode.IO);
    expect(e.name).toBe("GeoPackageError");
    expect(e.message).toBe("no such table: gpkg_contents");
  });
});
