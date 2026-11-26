/**
 * Real module, wave C part 1: pollutants, land uses and quality, initial
 * quality and the mass balance. tests/fixtures/smoke.inp has no quality, so
 * the test adds it through the API before running.
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

describe.skipIf(!built)(title("real module: wave C part 1"), () => {
  it("adds and edits pollutants", async () => {
    const { pkg, solver } = await opened();
    try {
      const tss = solver.pollutants.add("TSS");
      expect(tss.id).toBe("TSS");
      expect(tss.units).toBe(pkg.ConcentrationUnits.MG_PER_L);
      tss.rainConc = 2;
      tss.kdecay = 0.1;
      tss.initConc = 5;
      expect([tss.rainConc, tss.kdecay, tss.initConc]).toEqual([2, 0.1, 5]);
      const lead = solver.pollutants.add("Lead", pkg.ConcentrationUnits.UG_PER_L);
      expect(() => tss.id).toThrow(pkg.StaleObjectError); // as in Python
      lead.setCoPollutant("TSS", 0.25);
      const [co, frac] = lead.coPollutant!;
      expect([co.id, frac]).toEqual(["TSS", 0.25]);
      expect(solver.pollutants.get(0).coPollutant).toBeNull();
      expect([...solver.pollutants].map((p) => p.id)).toEqual(["TSS", "Lead"]);
      expect(solver.pollutants.has("Lead")).toBe(true);
      solver.pollutants.rename("Lead", "Pb");
      expect(solver.pollutants.getId(1)).toBe("Pb");
    } finally {
      solver.destroy();
    }
  });

  it("land uses, buildup, washoff, coverage, treatment and initial quality, then a run", async () => {
    const { pkg, solver } = await opened();
    try {
      solver.pollutants.add("TSS");
      const q = solver.quality;
      const res = q.landuses.add("RES");
      res.sweepInterval = 7;
      expect(solver.quality.landuses.get("RES").sweepInterval).toBe(7);
      q.setBuildup("RES", "TSS", { func: pkg.BuildupFunc.POW, c1: 50, c2: 0.5, c3: 2 });
      expect(q.getBuildup("RES", "TSS")).toEqual({
        func: pkg.BuildupFunc.POW,
        c1: 50,
        c2: 0.5,
        c3: 2,
        normalizer: 0,
      });
      q.setWashoff("RES", "TSS", { func: pkg.WashoffFunc.EXP, coeff: 0.1, expon: 1.5 });
      expect(q.getWashoff("RES", "TSS").expon).toBe(1.5);
      solver.subcatchments.get("S1").coverage.set("RES", 1);
      expect([...solver.subcatchments.get("S1").coverage]).toEqual(["RES"]);
      expect(q.validateTreatmentExpression("C = 0.5 * C")[0]).toBe(true);
      expect(q.validateTreatmentExpression("C = (")[0]).toBe(false);
      q.setTreatment("J1", "TSS", "R = 0.5");
      expect(q.getTreatment("J1", "TSS")).toBe("R = 0.5");

      const iq = solver.initialQuality;
      iq.set("TSS", 3, { node: "J1" });
      iq.set(iq.WATER_AGE, 2, { link: "C1" });
      const rows = [...solver.initialQuality];
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        isLink: false,
        elemIndex: solver.nodes.getIndex("J1"),
        constituent: "TSS",
        value: 3,
      });
      expect(() => solver.initialQuality.set("TSS", 1, {})).toThrow(pkg.BadParamError);
      solver.initialQuality.remove(1);
      expect(solver.initialQuality.length).toBe(1);

      solver.initialize();
      solver.start(true);
      while (solver.step() > 0);
      solver.end();
      expect(Math.max(...solver.nodes.qualities("TSS"))).toBeGreaterThanOrEqual(0);
      const mb = solver.massBalance;
      expect(Math.abs(mb.runoffContinuityError)).toBeLessThan(5);
      expect(Math.abs(mb.routingContinuityError)).toBeLessThan(5);
      expect(Number.isFinite(mb.qualityContinuityError("TSS"))).toBe(true);
      expect(mb.routingTotal(pkg.RoutingTotal.OUTFLOW)).toBeGreaterThan(0);
      const diag = mb.routingDiagnostics;
      expect(diag.nSteps).toBeGreaterThan(0);
      expect(diag.maxCourant).toBe(mb.maxCourant);
    } finally {
      solver.destroy();
    }
  });
});
