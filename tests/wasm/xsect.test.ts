/**
 * Real module: `XSectionGeometry` built from parameters, transects, shape
 * curves and streets, and copied from a link of tests/fixtures/smoke.inp.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { built, fixtures, load, title } from "./load.js";

describe.skipIf(!built)(title("real module: XSectionGeometry"), () => {
  it("queries a 1 m circular pipe with numbers and arrays alike", async () => {
    const { mod, pkg } = await load();
    const pipe = new pkg.XSectionGeometry(mod, pkg.XSectShape.CIRCULAR, 1, { units: "SI" });
    try {
      expect(pipe.shape).toBe(pkg.XSectShape.CIRCULAR);
      expect(pipe.units).toBe("SI");
      expect(pipe.flowUnits).toBe("CMS");
      expect(pipe.isOpen).toBe(false);
      expect(pipe.fullDepth).toBeCloseTo(1, 12); // SI is stored in ft internally
      expect(pipe.fullArea).toBeCloseTo(Math.PI / 4, 6);
      expect(pipe.area(0.5)).toBeCloseTo(Math.PI / 8, 3);
      const depths = [0.1, 0.5, 0.9];
      const areas = pipe.area(depths);
      expect(areas).toBeInstanceOf(Float64Array);
      expect(Array.from(areas)).toEqual(depths.map((d) => pipe.area(d)));
      expect(pipe.depthFromArea(pipe.area(0.3))).toBeCloseTo(0.3, 4); // tabulated geometry
      expect(pipe.area([])).toEqual(new Float64Array(0));
      expect(() => pipe.area(-1)).toThrow(pkg.BadParamError);
      expect(pkg.shapeName(mod, pkg.XSectShape.CIRCULAR)).toBe("CIRCULAR");
    } finally {
      pipe.destroy();
    }
    expect(() => pipe.fullDepth).toThrow(pkg.StaleObjectError);
    pipe.destroy(); // idempotent
  });

  it("builds open channels from a trapezoid, a transect, a shape curve and a street", async () => {
    const { mod, pkg } = await load();
    const trap = new pkg.XSectionGeometry(mod, pkg.XSectShape.TRAPEZOIDAL, [2, 3, 1, 1], {
      units: "US",
    });
    expect(trap.isOpen).toBe(true);
    expect(trap.fullArea).toBeCloseTo(2 * 3 + 2 * 2, 9); // b·y + z·y² with z = 1 per side
    trap.destroy();

    const channel = pkg.XSectionGeometry.fromTransect(mod, [0, 5, 10], [3, 0, 3], {
      leftBank: 0,
      rightBank: 10,
      nChannel: 0.03,
      units: "SI",
    });
    expect(channel.fullDepth).toBeCloseTo(3, 9);
    expect(channel.fullArea).toBeGreaterThan(0);
    channel.destroy();

    const custom = pkg.XSectionGeometry.fromCurve(mod, 2, [0, 0.5, 1], [0.5, 1, 0.5], {
      units: "SI",
    });
    expect(custom.fullDepth).toBeCloseTo(2, 12);
    custom.destroy();

    const street = pkg.XSectionGeometry.fromStreet(mod, 10, 0.5, 2, 0.016, { units: "US" });
    expect(street.isOpen).toBe(true);
    street.destroy();

    expect(
      () => new pkg.XSectionGeometry(mod, pkg.XSectShape.CIRCULAR, 1, { units: "metric" as "SI" }),
    ).toThrow(pkg.BadParamError);
    // IRREGULAR has no inline geometry: it must come from a transect.
    expect(
      () => new pkg.XSectionGeometry(mod, pkg.XSectShape.IRREGULAR, 1, { units: "SI" }),
    ).toThrow(/cannot build a IRREGULAR cross-section/);
  });

  it("copies a link's geometry, which outlives the solver", async () => {
    const { mod, pkg } = await load();
    const solver = new pkg.Solver(mod);
    solver.writeFile("/smoke.inp", readFileSync(resolve(fixtures, "smoke.inp"), "utf8"));
    solver.open("/smoke.inp", "/smoke.rpt", "/smoke.out");
    const xs = pkg.XSectionGeometry.fromLink(solver.links.get("C1"));
    solver.close();
    solver.destroy();
    try {
      expect(xs.shape).toBe(pkg.XSectShape.CIRCULAR);
      expect(xs.units).toBe("US");
      expect(xs.flowUnits).toBe("CFS");
      expect(xs.fullDepth).toBe(1.5);
      expect(xs.criticalDepth(5)).toBeGreaterThan(0);
    } finally {
      xs.destroy();
    }
  });
});
