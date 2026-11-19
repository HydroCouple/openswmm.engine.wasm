/**
 * Real module, wave B (part 1): gages, controls, forcing and snow on
 * tests/fixtures/smoke.inp (gage RG1 on TS1, subcatchment S1, nodes J1..O1,
 * conduits C1..C3).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { built, fixtures, load, title } from "./load.js";

async function opened() {
  const { mod, pkg } = await load();
  const solver = new pkg.Solver(mod);
  solver.writeFile("/smoke.inp", readFileSync(resolve(fixtures, "smoke.inp"), "utf8"));
  solver.open("/smoke.inp", "/smoke.rpt", "/smoke.out");
  return { mod, pkg, solver };
}

const RULE = (id: string, link: string) =>
  `RULE ${id}\nIF NODE J1 DEPTH > 1\nTHEN CONDUIT ${link} STATUS = CLOSED\n`;

describe.skipIf(!built)(title("real module: wave B part 1"), () => {
  it("gages: add, rename, ids, series and invalidation", async () => {
    const { pkg, solver } = await opened();
    try {
      const { gages } = solver;
      const first = gages.get(0);
      const firstId = first.id;
      expect(first.solver).toBe(solver);
      expect(gages.has(firstId)).toBe(true);
      const g = gages.add("RG2");
      expect(gages.ids).toEqual([firstId, "RG2"]);
      expect(() => first.id).toThrow(pkg.StaleObjectError); // as in Python
      g.setTimeseries("TS1");
      expect(g.timeseries).toBe("TS1");
      g.setRainInterval(900);
      expect(g.rainInterval).toBe(900);
      gages.rename("RG2", "RG3");
      expect(gages.has("RG3")).toBe(true);
      expect(gages.has("RG2")).toBe(false);
      const series = gages.get(0).rainfallSeries;
      expect(series.length).toBeGreaterThan(0);
      expect(series[0][0]).toBeInstanceOf(Date);
    } finally {
      solver.destroy();
    }
  });

  it("controls: append, insert, set, delete, find references, validate and replace", async () => {
    const { pkg, solver } = await opened();
    try {
      const { controls } = solver;
      controls.append(RULE("R1", "C1"));
      controls.append({ id: "R3", text: RULE("R3", "C3") });
      controls.insert(1, RULE("R2", "C2"));
      expect([...controls].map((r) => r.id)).toEqual(["R1", "R2", "R3"]);
      expect(controls.get(-1).id).toBe("R3");
      controls.set(0, RULE("R1", "C2"));
      expect(controls.findReferences("C2")).toEqual([0, 1]);
      controls.delete(-1);
      expect(controls.length).toBe(2);
      const [ok, message] = controls.validateMessage("RULE bad\nIF NOTHING\n");
      expect(ok).toBe(false);
      expect(message).not.toBe("");
      expect(controls.validateMessage(RULE("R9", "C1"))[0]).toBe(true);
      controls.replaceProgram([RULE("A", "C1"), RULE("B", "C2")]);
      expect([...controls].map((r) => r.id)).toEqual(["A", "B"]);
      expect(() => controls.replaceProgram(["RULE X\nIF NOTHING\n"])).toThrow(pkg.EngineError);
      expect(controls.length).toBe(2); // a refused program leaves the old one
      controls.clear();
      expect(controls.length).toBe(0);
    } finally {
      solver.destroy();
    }
  });

  it("forcing: subcatchment, climate and quality members by id", async () => {
    const { pkg, solver } = await opened();
    try {
      solver.initialize();
      solver.start(true);
      const { forcing } = solver;
      forcing.subcatchmentRainfall(solver.subcatchments.getId(0), 1.5);
      forcing.subcatchmentEvap(0, 0.01, pkg.ForcingMode.ADD, true);
      forcing.climateTemperature(5);
      forcing.climateWind(3);
      forcing.climateEvap(0.02);
      forcing.climateDryOnly(true);
      solver.step();
      expect(forcing.getClimateDryOnly()).toBe(true);
      expect(Number.isFinite(forcing.climateEvapRate())).toBe(true);
      expect(Number.isFinite(forcing.getClimateTemperature())).toBe(true);
      expect(Number.isFinite(forcing.getClimateWindSpeed())).toBe(true);
      expect(() => forcing.subcatchmentRainfall("no-such", 1)).toThrow(pkg.ElementNotFoundError);
      expect(() => forcing.elementClimateGet(7 as pkg.HeatElemKind, 0, 0)).toThrow(
        pkg.BadParamError,
      );
    } finally {
      solver.destroy();
    }
  });

  it("snow: model, step, ranges, radiation, cloud and named packs", async () => {
    const { pkg, solver } = await opened();
    try {
      const snow = solver.snow;
      expect(["UEB", "DEGREE_DAY"]).toContain(snow.model);
      expect(snow.stepSeconds).toBeGreaterThan(0);
      const ranges = snow.monthlyRanges;
      expect(ranges).toHaveLength(12);
      snow.monthlyRanges = ranges.map((r, i) => r + i * 0.5);
      expect(snow.monthlyRanges[11]).toBeCloseTo(ranges[11] + 5.5, 12);
      expect(() => (snow.monthlyRanges = [1, 2])).toThrow(pkg.BadParamError);
      const radiation = snow.radiation;
      expect(radiation).toHaveProperty("latitude");
      snow.radiation = { ...radiation, explicitSite: 1, latitude: 45 }; // site used only when explicit
      expect(snow.radiation.latitude).toBe(45);
      expect(snow.cloud).toHaveProperty("series");

      const surface = [
        [0.001, 0.001, 32, 0.1, 0, 0, 1],
        [0.001, 0.001, 32, 0.1, 0, 0, 0],
        [0.001, 0.001, 32, 0.1, 0, 0, 0],
      ];
      const ueb = {
        model: 0,
        forestFraction: 0.2,
        driftFactor: 1,
        groundHeatWm2: 2,
        extinctionDepthM: 0.1,
        initialEnergyKjm2: 0,
      };
      snow.applyPacks([{ name: "SP1", surface, removal: [1, 0, 0, 0, 0, 0], ueb }]);
      const fresh = solver.snow; // the edit invalidated the earlier view
      expect(() => snow.pack("SP1")).toThrow(pkg.StaleObjectError);
      expect(fresh.pack("SP1").forestFraction).toBe(0.2);
      fresh.setPack("SP1", { driftFactor: 1.5 });
      expect(fresh.pack("SP1").driftFactor).toBe(1.5);
      expect(() => fresh.setPack("SP1", { drift_factor: 1 })).toThrow(pkg.BadParamError);
      expect(() => (fresh.radiation = { explicit_site: 1 })).toThrow(RangeError);
      expect(() => fresh.setPack("SP1", { nope: 1 })).toThrow(pkg.BadParamError);
      expect(() => fresh.applyPacks([{ name: "bad", surface: [[1]], removal: [], ueb }])).toThrow(
        pkg.BadParamError,
      );
    } finally {
      solver.destroy();
    }
  });
});
