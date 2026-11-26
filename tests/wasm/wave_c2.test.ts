/**
 * Real module, wave C part 2: climate settings and the evaporation preview,
 * run statistics and the report summary tables on tests/fixtures/smoke.inp.
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

describe.skipIf(!built)(title("real module: wave C part 2"), () => {
  it("reads and writes climate settings and previews evaporation", async () => {
    const { pkg, solver } = await opened();
    try {
      const climate = solver.climate;
      const monthly = Array.from({ length: 12 }, (_, i) => 0.1 + i / 100);
      climate.evapType = pkg.EvapType.MONTHLY;
      climate.evapMonthly = monthly;
      climate.evapMonthly.forEach((v, i) => expect(v).toBeCloseTo(monthly[i], 12)); // stored in internal units
      climate.latitude = 41.5;
      expect(climate.latitude).toBe(41.5);
      climate.snowTemp = 34;
      expect(climate.snowTemp).toBe(34);
      climate.adcImpervious = Array.from({ length: 10 }, (_, i) => i / 10);
      expect(climate.adcImpervious).toHaveLength(10);
      expect(() => (climate.windMonthly = [1, 2, 3])).toThrow(pkg.BadParamError);
      expect(climate.adjustRainfall).toHaveLength(12);

      const start = solver.startDatetime; // the preview must stay within the simulation dates
      const end = solver.endDatetime;
      const step = (end.getTime() - start.getTime()) / 86400000 / 4;
      const preview = climate.previewEvaporation(start, end, step);
      expect(preview.samples.length).toBeGreaterThan(0);
      expect(preview.samples[0].effective_rate).toBeCloseTo(monthly[start.getUTCMonth()], 9);
      expect(preview.summary.runtime_forcing_unknown).toBe(true);
      const draft = climate.previewEvaporation(start, end, step, {
        config: { evap_monthly: new Array(12).fill(0.3) },
      });
      expect(draft.samples[0].effective_rate).toBeCloseTo(0.3, 9);
      expect(climate.evapMonthly[0]).toBeCloseTo(monthly[0], 12); // a draft changes nothing
      expect(() => climate.previewEvaporation(start, end, step, { config: { bogus: 1 } })).toThrow(
        pkg.BadParamError,
      );
    } finally {
      solver.destroy();
    }
  });

  it("reads statistics and summary tables after a run", async () => {
    const { pkg, solver } = await opened();
    try {
      solver.initialize();
      solver.start(true);
      while (solver.step() > 0);
      solver.end();
      const st = solver.statistics;
      expect(st.nodeMaxDepth.length).toBe(solver.nodes.length);
      expect(st.nodeMaxDepthAt(0)).toBe(st.nodeMaxDepth[0]);
      expect(st.linkMaxFlow.length).toBe(solver.links.length);
      expect(Math.max(...st.linkMaxFlow)).toBeGreaterThan(0);
      expect(st.subcatchmentPrecip.length).toBe(solver.subcatchments.length);
      expect(st.subcatchmentRunoffVolAt(0)).toBe(st.subcatchmentRunoffVol[0]);

      const depth = st.summaryTable(pkg.SummaryTable.NODE_DEPTH);
      expect(depth.title).toBe("Node Depth Summary");
      expect(depth.rows).toHaveLength(solver.nodes.length);
      expect(depth.values).toHaveLength(depth.rows.length * depth.columns.length);
      expect(depth.rows[0].objectType).toBe(pkg.SummaryObject.NODE);
      expect(depth.rows[0].label).toBe("JUNCTION"); // the report's type column
      expect(solver.nodes.getId(depth.rows[0].objectIndex)).toBe(solver.nodes.getId(0));
      expect(st.summaryValueAt(pkg.SummaryTable.NODE_DEPTH, 0, 0)).toBe(depth.values[0]);
      expect(st.summaryRowAt(pkg.SummaryTable.NODE_DEPTH, 0)).toEqual(depth.rows[0]);
      const all = st.summaryTables();
      expect(all.map((t) => t.table)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    } finally {
      solver.destroy();
    }
  });
});
