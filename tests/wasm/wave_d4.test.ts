/**
 * Real module, wave D part 4: GeoPackage (observed series, transactions,
 * read-only SQL) and Solver.writeGeopackage on tests/fixtures/smoke.inp.
 *
 * The written model is copied to tests/_work/wasm/d4/smoke.wasm.gpkg;
 * tests/_work/wasm/d4/crosscheck.py (run by hand) compares its tables with a
 * natively written copy.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { built, fixtures, load, title, work } from "./load.js";

describe.skipIf(!built)(title("real module: wave D part 4 (GeoPackage)"), () => {
  it("creates, writes and reads observed series and runs SQL", async () => {
    const { mod, pkg } = await load();
    const { GeoPackage } = pkg;
    expect(typeof pkg.isGeoPackageRegistered(mod)).toBe("boolean");
    expect(typeof pkg.registerGeoPackage(mod, "", "test-org", "", "test-deploy")).toBe("boolean");

    const gpkg = new GeoPackage(mod, "/obs.gpkg");
    try {
      expect(gpkg.simulationCount()).toBe(0);
      expect(gpkg.simulationIds()).toEqual([]);
      expect(typeof gpkg.lastError).toBe("string");
      const sid = gpkg.createObservedSeries("flow", "flow", "NODE", "J1", "Test", "CFS");
      expect(sid).toBeGreaterThanOrEqual(0);
      gpkg.writeObservedValue(sid, "2026-01-15T08:00:00Z", 1.5, "A");
      const bulk = gpkg.createObservedSeries("bulk", "depth");
      const stamps = Array.from({ length: 120 }, (_, i) => {
        const d = new Date(Date.UTC(2026, 0, 15, 0, i));
        return d.toISOString().replace(".000Z", "Z");
      });
      gpkg.begin();
      expect(() => gpkg.begin()).toThrow(pkg.LifecycleError);
      gpkg.writeObservedValues(
        bulk,
        stamps,
        stamps.map((_, i) => i / 4),
      );
      gpkg.commit();
      expect(() => gpkg.commit()).toThrow(pkg.LifecycleError);
      expect(gpkg.observedSeriesCount()).toBe(2);
      expect(gpkg.observedValueCount(bulk)).toBe(120);
      const [ts, vs] = gpkg.readObservedValues(bulk);
      expect(ts[0]).toBe("2026-01-15T00:00:00Z");
      expect(Array.from(vs.subarray(0, 3))).toEqual([0, 0.25, 0.5]);
      expect(gpkg.readObservedValues(sid)[1][0]).toBe(1.5);
      expect(() => gpkg.writeObservedValues(bulk, ["x"], [1, 2])).toThrow(RangeError);

      expect(gpkg.queryInt("SELECT 42")).toBe(42);
      expect(gpkg.queryDouble("SELECT 3.14159")).toBeCloseTo(3.14159, 12);
      expect(() => gpkg.queryDouble("SELECT x FROM no_such_table")).toThrow(pkg.GeoPackageError);
      expect(() => gpkg.readSummary("sim", "NODE", "J1", "depth")).toThrow(
        pkg.ElementNotFoundError,
      );
      const [t0, v0] = gpkg.readResultTs("sim", "NODE", "J1", "depth");
      expect([t0.length, v0.length]).toEqual([0, 0]);
      expect(gpkg.objectCounts("sim")).toEqual({ nodes: 0, links: 0, subcatchments: 0, gages: 0 });
    } finally {
      gpkg.close();
      gpkg.close();
    }
    expect(() => gpkg.simulationCount()).toThrow(pkg.StaleObjectError);
  });

  it("writes the model as a GeoPackage", async () => {
    const { mod, pkg } = await load();
    const solver = new pkg.Solver(mod);
    try {
      solver.writeFile("/smoke.inp", readFileSync(resolve(fixtures, "smoke.inp"), "utf8"));
      solver.open("/smoke.inp", "/smoke.rpt", "/smoke.out");
      solver.writeGeopackage("/smoke.gpkg", "EPSG:32618");
      expect(solver.spatial.crs).toBe("EPSG:32618");
      const out = resolve(work, "d4");
      mkdirSync(out, { recursive: true });
      writeFileSync(resolve(out, "smoke.wasm.gpkg"), solver.readFile("/smoke.gpkg"));
      using gpkg = new pkg.GeoPackage(mod, "/smoke.gpkg");
      expect(gpkg.queryInt("SELECT COUNT(*) FROM gpkg_contents")).toBeGreaterThan(0);
      expect(gpkg.queryInt("SELECT COUNT(*) FROM gpkg_spatial_ref_sys WHERE srs_id = 32618")).toBe(
        1,
      );
    } finally {
      solver.destroy();
    }
  });
});
