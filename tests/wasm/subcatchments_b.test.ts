/**
 * Real module, wave B: subcatchment members, the infiltration/coverage/
 * loadings/stats sub-views, the Subcatchments collection, and the aquifer and
 * snowpack collections on tests/fixtures/smoke.inp (S1, S2 on gage G1, Horton).
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

describe.skipIf(!built)(title("real module: subcatchments (wave B)"), () => {
  it("reads and writes subcatchment properties, outlet, gage and infiltration", async () => {
    const { pkg, solver } = await opened();
    try {
      const s1 = solver.subcatchments.get("S1");
      expect(s1.solver).toBe(solver);
      expect(s1.gage.id).toBe("G1");
      const outlet = s1.outlet;
      expect(outlet && "id" in outlet ? outlet.id : null).toBe("J1");
      s1.setOutletSubcatchment("S2");
      expect((s1.outlet as { id: string }).id).toBe("S2");
      s1.setOutletNode("J1");
      s1.nImperv = 0.012;
      s1.dsPerv = 0.1;
      s1.zeroImpervPct = 30;
      expect([s1.nImperv, s1.dsPerv, s1.zeroImpervPct]).toEqual([0.012, 0.1, 30]);
      s1.rainScaleFactor = 1.1;
      expect(s1.rainScaleFactor).toBeCloseTo(1.1, 12);
      s1.tag = "roof";
      expect(s1.tag).toBe("roof");
      expect(s1.snowpack).toBe("");
      expect(s1.aquifer).toBeNull();
      expect(s1.gwNode).toBeNull();

      const inf = s1.infiltration;
      expect(inf.model).toBe(pkg.InfilModel.HORTON);
      expect(inf.horton).toEqual([3, 0.5, 4, 7]);
      inf.setHorton(2, 0.4, 3, 6);
      expect(inf.horton).toEqual([2, 0.4, 3, 6]);
      expect([...s1.coverage]).toEqual([]);
      expect(s1.coverages()).toEqual([]);
      expect([...s1.loadings]).toEqual([]);
      expect(() => s1.coverage.delete("x")).toThrow(TypeError);
    } finally {
      solver.destroy();
    }
  });

  it("aquifers and snowpacks: add, parameters and assignment", async () => {
    const { pkg, solver } = await opened();
    try {
      const aquifers = solver.aquifers;
      expect(aquifers.add("AQ1")).toBe(0);
      const fresh = solver.aquifers; // add invalidated the solver's views
      expect([...fresh]).toEqual(["AQ1"]);
      expect(fresh.has("AQ1")).toBe(true);
      fresh.setParam("AQ1", 0, 0.5);
      expect(fresh.getParam("AQ1", 0)).toBe(0.5);
      const s1 = solver.subcatchments.get("S1");
      s1.aquifer = "AQ1";
      expect(s1.aquifer).toBe(0);
      s1.gwNode = "J1";
      expect(s1.gwNode).toBe(solver.nodes.getIndex("J1"));
      s1.setGwParams(10, 0.1, 1, 0.1, 1, 0, 0, 0);
      expect(s1.gwParams.surfElev).toBe(10);

      const packs = solver.snowpacks;
      packs.add("SP1");
      const sp = solver.snowpacks;
      const surface = { cmin: 0.001, cmax: 0.002, tbase: 32, fwfrac: 0.1, sd0: 0, fw0: 0, last: 1 };
      sp.setPlowable("SP1", surface);
      expect(sp.getPlowable("SP1")).toEqual(surface);
      sp.setRemoval("SP1", { dsnow: 1, fout: 0, fimp: 0, fperv: 0, fimelt: 0, fsubcatch: 0 });
      expect(sp.getRemoval(0).dsnow).toBe(1);
      solver.subcatchments.get("S2").snowpack = "SP1";
      expect(solver.subcatchments.get("S2").snowpack).toBe("SP1");
      expect(() => sp.getIndex("nope")).toThrow(pkg.ElementNotFoundError);
    } finally {
      solver.destroy();
    }
  });

  it("collection: ids, add/rename, groundwater expressions and bulk values from a run", async () => {
    const { pkg, solver } = await opened();
    try {
      const subs = solver.subcatchments;
      expect(subs.ids).toEqual(["S1", "S2"]);
      expect(subs.gwfVariables().length).toBeGreaterThan(0);
      expect(subs.gwfFunctions().length).toBeGreaterThan(0);
      expect(subs.validateGwfExpression("0.001 * Hgw")[0]).toBe(true);
      const [ok, message] = subs.validateGwfExpression("0.001 * (");
      expect(ok).toBe(false);
      expect(message).not.toBe("");
      subs.setGwfExpression("S1", pkg.GwfType.LATERAL, "0.001 * Hgw");
      expect(subs.getGwfExpression("S1", pkg.GwfType.LATERAL)).toBe("0.001 * Hgw");
      subs.add("S3");
      subs.rename("S3", "S4");
      expect(subs.has("S4")).toBe(true);
      subs.rename("S4", "S3");

      solver.initialize();
      solver.start(true);
      solver.until(1800);
      expect(subs.rainfalls.length).toBe(subs.length);
      expect(Math.max(...subs.rainfalls)).toBeGreaterThan(0);
      expect(subs.infils.length).toBe(subs.length);
      expect(subs.evaps.length).toBe(subs.length);
      expect(subs.snowDepths.length).toBe(subs.length);
      while (solver.step() > 0);
      solver.end();
      const stats = subs.get("S1").stats;
      expect(stats.precip).toBeGreaterThan(0);
      expect(stats.runoffVol).toBeGreaterThan(0);
      expect(stats.maxRunoff).toBeGreaterThan(0);
    } finally {
      solver.destroy();
    }
  });
});
