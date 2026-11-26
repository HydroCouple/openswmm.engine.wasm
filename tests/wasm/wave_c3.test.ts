/**
 * Real module, wave C part 3: external and dry-weather inflows, RDII, unit
 * hydrographs and RDII decay on tests/fixtures/smoke.inp (TS1, gage G1).
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

describe.skipIf(!built)(title("real module: wave C part 3 (inflows)"), () => {
  it("edits every inflow table and runs with an external inflow", async () => {
    const { solver } = await opened();
    try {
      const inflows = solver.inflows;
      const j1 = solver.nodes.getIndex("J1");

      inflows.addExternal("J1", "FLOW", { tsName: "TS1", baseline: 0.5 });
      expect(inflows.externalCount).toBe(1);
      expect(inflows.getExternal(0)).toEqual([j1, "FLOW", "TS1", "FLOW", 1, 1, 0.5, ""]);
      inflows.setExternalScale(0, 2);
      inflows.setExternalBaseline(0, 0.25);
      expect(inflows.getExternal(0).slice(5, 7)).toEqual([2, 0.25]);

      solver.patterns.add("H");
      inflows.addDwf("J1", "FLOW", { avgValue: 0.1, hourlyPattern: "H" });
      expect(inflows.dwfCount).toBe(1);
      expect(inflows.getDwf(0)).toEqual([j1, "FLOW", 0.1, "", "", "H", ""]);
      inflows.setDwfBaseline(0, 0.2);
      expect(inflows.getDwf(0)[2]).toBe(0.2);

      inflows.addHydrograph("UH1", 0, 1, 0.1, 1, 2, { dmax: 0.5 });
      inflows.addHydrograph("UH1", 0, 2, 0.05, 3, 2);
      inflows.setHydrographGage("UH1", "G1");
      expect(inflows.hydrographGroupCount).toBe(1);
      expect(inflows.getHydrographGroupId(0)).toBe("UH1");
      expect(inflows.hydrographCount).toBeGreaterThanOrEqual(2);
      const short = [...Array(inflows.hydrographCount).keys()]
        .map((i) => inflows.getHydrograph(i))
        .find((h) => h.response === 1)!;
      expect([short.uhName, short.r, short.t, short.k, short.dmax]).toEqual([
        "UH1",
        0.1,
        1,
        2,
        0.5,
      ]);
      inflows.setHydrographRtk("UH1", 0, 1, 0.2, 1, 2);
      inflows.addRdii("J1", "UH1", 10);
      expect(inflows.rdiiCount).toBe(1);
      expect(inflows.getRdii(0)).toEqual({ nodeIndex: j1, uhName: "UH1", area: 10 });

      const decay = { k_dep: 0.1, k_0: 0.2, k_T: 0.3, T_ref: 20, theta_rec: 0.4, T_freeze: 0 };
      inflows.addRdiiDecay("UH1", 1, decay);
      expect(inflows.rdiiDecayCount).toBe(1);
      expect(inflows.getRdiiDecay(0)).toMatchObject({
        uhName: "UH1",
        response: 1,
        ...decay,
        snow_on: false,
      });
      inflows.removeRdiiDecay("UH1", 1);
      expect(inflows.rdiiDecayCount).toBe(0);

      inflows.removeRdii(0);
      inflows.removeDwf(0);
      expect([inflows.rdiiCount, inflows.dwfCount]).toEqual([0, 0]);

      solver.initialize();
      solver.start(true);
      solver.until(1800);
      expect(solver.nodes.get("J1").lateralInflow).toBeGreaterThan(0);
    } finally {
      solver.destroy();
    }
  });
});
