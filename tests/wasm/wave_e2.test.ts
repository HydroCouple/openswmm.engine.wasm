/**
 * Real module, wave E part 2: capabilities, process components, water age,
 * mesh snow and 2D surface quality.
 *
 * Decks: smoke.inp; the engine's water-age parity deck (steady_quality.inp),
 * its UEB mesh snow fixture (soa_ueb_mesh.inp) and the mixed-cell model of
 * python/tests/engine/_groundwater_cases.py (with the surface-quality test's
 * land use). Values read here go to tests/_work/wasm/e2/wave_e2.json for
 * tests/_work/wasm/e2/crosscheck.py (run by hand with native Python).
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { built, fixtures, load, root, title, work } from "./load.js";
import { MIXED_CELL_MODEL } from "./decks.js";

const ENGINE = resolve(root, "extern/openswmm.engine");
const WATER_AGE_DECK = resolve(ENGINE, "tests/parity/corpus/decks/steady_quality.inp");
const SNOW_DECK = resolve(ENGINE, "tests/benchmarks/generated/soa_review_2026-10/soa_ueb_mesh.inp");

async function opened(text: string) {
  const { mod, pkg } = await load();
  const solver = new pkg.Solver(mod);
  solver.writeFile("/deck.inp", text);
  solver.open("/deck.inp", "/deck.rpt", "/deck.out");
  return { mod, pkg, solver };
}

describe.skipIf(!built)(
  title("real module: wave E part 2 (components, age, snow, quality)"),
  () => {
    const evidence: Record<string, unknown> = {};
    afterAll(() => {
      const out = resolve(work, "e2");
      mkdirSync(out, { recursive: true });
      writeFileSync(resolve(out, "wave_e2.json"), JSON.stringify(evidence, null, 1) + "\n");
    });

    it("describes the build", async () => {
      const { mod, pkg } = await load();
      const caps = pkg.capabilities(mod);
      const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
      expect(caps.version).toBe(version);
      expect(pkg.VERSION).toBe(version);
      expect(caps.catalog_revision).toBe(pkg.catalog.revision());
      expect(caps.features).toEqual({ "2d": true, geopackage: true, hdf5_2d_output: true });
      expect(caps.checkpoints).toContain("inspection");
      expect(caps.checkpoints).toContain("save_new"); // exclusive publication under Emscripten
      expect(caps.checkpoints).toContain("bundle_export");
      expect(caps.threads.omp_available).toBe(false);
      expect(caps.component_libraries).toEqual([]);
      evidence.capabilities = caps;
    });

    it("registers process components and their arguments", async () => {
      const { mod, pkg, solver } = await opened(
        readFileSync(resolve(fixtures, "smoke.inp"), "utf8"),
      );
      const { ProcessComponents } = pkg;
      try {
        evidence.known = ProcessComponents.known(mod);
        expect(ProcessComponents.libraries(mod)).toEqual([]);
        expect(() => ProcessComponents.addSearchPath(mod, "/")).toThrow(pkg.EngineError);
        const pc = solver.processComponents;
        expect(pc.length).toBe(0);
        const row = pc.register("reactions", "model.rxn");
        expect(row).toEqual({
          componentIndex: 0,
          id: "reactions",
          config: "model.rxn",
          resolved: "",
        });
        expect(pc.has("reactions") && !pc.has("nope")).toBe(true);
        expect(pc.get(-1)).toEqual(row);
        expect(pc.getIndex("reactions")).toBe(0);
        expect(() => pc.register("reactions")).toThrow(pkg.BadParamError);
        pc.setArgument("reactions", "mode", "fast");
        expect(pc.arguments(0)).toEqual([["mode", "fast"]]);
        pc.setArgument(0, "mode", null);
        expect(pc.arguments(0)).toEqual([]);
        expect([...pc].map((c) => c.id)).toEqual(["reactions"]);
        expect(() => pc.get(3)).toThrow(RangeError);
        expect(() => pc.get("nope")).toThrow(pkg.ElementNotFoundError);
        pc.remove("reactions");
        expect(pc.length).toBe(0);
      } finally {
        solver.destroy();
      }
    });

    it("edits the water age source table", async () => {
      const { pkg, solver } = await opened(readFileSync(WATER_AGE_DECK, "utf8"));
      const { WaterAgeSource } = pkg;
      try {
        const age = solver.waterAge;
        expect(age.enabled).toBe(true);
        const g = age.globals;
        expect(g.length).toBe(7);
        expect([...g]).toEqual([0, 1, 2, 3, 4, 5, 6]);
        evidence.ageGlobalsBefore = [...g].map((s) => g.get(s));
        g.set("dwf", 6);
        g.set(WaterAgeSource.RAINFALL, -1.5);
        expect(g.get(WaterAgeSource.DWF)).toBe(6);
        expect(g.has("ifACE") && !g.has("nope") && !g.has(9)).toBe(true);
        expect(() => g.get("nope")).toThrow(pkg.ElementNotFoundError);
        const o = age.nodeOverrides;
        o.set("DWF", "J1", -2);
        o.set(WaterAgeSource.EXTERNAL_INFLOW, 0, 4);
        o.set("DWF", "J1", -3); // updates the pair
        expect(() => o.set("RAINFALL", "J1", 1)).toThrow(pkg.BadParamError);
        evidence.ageOverrides = [...o];
        expect(o.length).toBe(2);
        expect(o.get(-1)).toEqual(o.get(o.length - 1));
        o.remove("EXTERNAL_INFLOW", "J0");
        expect(o.length).toBe(1);
        expect(() => o.remove("EXTERNAL_INFLOW", "J0")).toThrow(pkg.BadIndexError);
        age.save("/model.age");
        evidence.ageFile = solver.readFile("/model.age", "utf8");
      } finally {
        solver.destroy();
      }
    });

    it("reads mesh snow configuration, rows, states and ledgers", async () => {
      const { pkg, solver } = await opened(readFileSync(SNOW_DECK, "utf8"));
      try {
        const snow = solver.surface2d.snow;
        evidence.snowOptions = snow.options;
        evidence.snowConfiguration = snow.configuration();
        evidence.snowRows = snow.rows("defaults");
        expect(snow.rows("cells")).toEqual([]);
        expect(() => snow.rows("x" as "cells")).toThrow(RangeError);
        expect(() => snow.applyConfiguration("MODE BANANA")).toThrow(RangeError);
        solver.initialize();
        solver.start(false);
        solver.until(600);
        const states = snow.states();
        expect(states).toHaveLength(1);
        evidence.snowStates = states;
        evidence.snowLedgers = snow.ledgers();
        solver.end();
      } finally {
        solver.destroy();
      }
      expect(pkg.MeshSnow).toBeDefined();
    });

    it("authors 2D surface quality and reads buildup", async () => {
      const extra = "[LANDUSES]\nURBAN 0 0 0\n[BUILDUP]\nURBAN TSS POW 100 0 1 AREA\n";
      const { pkg, solver } = await opened(MIXED_CELL_MODEL + "\n" + extra);
      const { CellScope } = pkg;
      try {
        const q = solver.surface2d.quality;
        q.setCoverage(CellScope.GLOBAL, { URBAN: 100 });
        q.setLoading(CellScope.GLOBAL, "TSS", 10);
        q.setLoading(CellScope.TAG, "TSS", 20, { tag: "PAN" });
        q.setLoading(CellScope.CELL, "TSS", 30, { cell: 0 });
        q.setCurbLength(CellScope.GLOBAL, 25);
        expect(q.coverages[0].landuses).toEqual([["URBAN", 100]]);
        expect(q.loadings).toHaveLength(3);
        expect(q.curbLengths[0].length).toBe(25);
        expect(() => q.setCoverage(CellScope.GLOBAL, {})).toThrow(RangeError);
        expect(() => q.setCoverage(CellScope.GLOBAL, { URBAN: 101 })).toThrow(pkg.BadParamError);
        evidence.quality = {
          coverages: q.coverages,
          loadings: q.loadings,
          curbLengths: q.curbLengths,
        };
        solver.initialize();
        solver.start(false);
        const values = q.buildup("TSS");
        expect(Array.from(values)).toEqual([30, 20]);
        values[0] = -1;
        expect(q.buildup("TSS")[0]).toBe(30);
        expect(() => q.removeLoading(0)).toThrow(pkg.LifecycleError);
        solver.end();
      } finally {
        solver.destroy();
      }
    });
  },
);
