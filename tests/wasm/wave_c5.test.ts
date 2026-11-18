/**
 * Real module, wave C part 5: getReportSnapshot() on the engine's reduced
 * report-statistics model (storage, a variable-speed pump, a flooded storage
 * unit), checked against the .rpt the same run writes.
 *
 * The routing continuity error is the engine's exact ledger
 * (`swmm_get_routing_continuity_error`), while the printed Flow Routing
 * Continuity block uses legacy half-step totals, so on this deck the two differ
 * (0.052 % vs -0.173 %); the test checks it against the snapshot's own totals.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { built, load, root, title, work } from "./load.js";

const deck = resolve(
  root,
  "extern/openswmm.engine/tests/unit/engine/data/mc_storm_parity/report_statistics.inp",
);

/** The first number after `label` within the report section titled `section`. */
function rptValue(rpt: string, section: string, label: string): number {
  const from = rpt.indexOf(section);
  expect(from, section).toBeGreaterThan(-1);
  const m = rpt.slice(from).match(new RegExp(`${label}[ .]*\\s+(-?[\\d.]+)`));
  expect(m, label).not.toBeNull();
  return Number(m![1]);
}

describe.skipIf(!built)(title("real module: wave C part 5 (report snapshot)"), () => {
  it("matches the report's continuity and pumping tables", async () => {
    const { mod, pkg } = await load();
    const solver = new pkg.Solver(mod);
    try {
      solver.writeFile("/rs.inp", readFileSync(deck, "utf8"));
      solver.open("/rs.inp", "/rs.rpt", "/rs.out");
      solver.initialize();
      solver.start(true);
      while (solver.step()) {
        /* run to the end */
      }
      solver.end();
      const snap = pkg.getReportSnapshot(solver);
      solver.report();
      const rpt = solver.readFile("/rs.rpt", "utf8") as string;
      writeFileSync(resolve(work, "wave_c5.rpt"), rpt);
      writeFileSync(resolve(work, "wave_c5_snapshot.json"), JSON.stringify(snap, null, 2));

      expect(snap.runoffContinuity.continuityErrorPct).toBeCloseTo(
        rptValue(rpt, "Runoff Quantity Continuity", "Continuity Error \\(%\\)"),
        2,
      );
      const rc = snap.routingContinuity;
      const tin =
        rc.dryWeatherInflow +
        rc.wetWeatherInflow +
        rc.groundwaterInflow +
        rc.linkGroundwaterInflow +
        rc.rdiiInflow +
        rc.externalInflow +
        rc.initialStorage;
      const tout =
        rc.totalFlooding +
        rc.couplingOutflow +
        rc.totalOutflow +
        rc.evaporationLoss +
        rc.seepageLoss +
        rc.finalStorage;
      expect(rc.continuityErrorPct).toBeCloseTo((100 * (tin - tout)) / tin, 10);
      expect(snap.qualityContinuity).toEqual([]);
      expect(snap.routingDiagnostics.nSteps).toBeGreaterThan(0);

      expect(snap.storageSummary.map((e) => e.nodeId).sort()).toEqual(["FULL", "T"]);
      expect(snap.storageSummary.every((e) => e.nodeType === "STORAGE")).toBe(true);
      for (let i = 1; i < snap.nodeFlooding.length; i++) {
        expect(snap.nodeFlooding[i - 1].totalFloodVolume).toBeGreaterThanOrEqual(
          snap.nodeFlooding[i].totalFloodVolume,
        );
      }
      expect(snap.nodeFlooding.every((e) => e.totalFloodVolume > 0)).toBe(true);

      expect(snap.linkFlowSummary.map((e) => e.linkId).sort()).toEqual(["C", "C2", "P"]);
      for (let i = 1; i < snap.linkFlowSummary.length; i++) {
        expect(snap.linkFlowSummary[i - 1].maxFlow).toBeGreaterThanOrEqual(
          snap.linkFlowSummary[i].maxFlow,
        );
      }

      expect(snap.pumpSummary).toHaveLength(1);
      const pump = snap.pumpSummary[0];
      expect(pump.linkId).toBe("P");
      expect(pump.pumpCurveIdx).toBe(solver.tables.getIndex("PC"));
      expect(pump.pctTimeOn).toBeCloseTo(rptValue(rpt, "Pumping Summary", "P"), 0);
      expect(pump.numStartups).toBe(1); // the report's Start-Ups column

      expect(snap.subcatchmentSummary.map((e) => e.subcatchId)).toEqual(["S1", "S2"]);
      for (const s of snap.subcatchmentSummary) {
        expect(s.totalPrecip).toBeGreaterThan(0);
        expect(s.runoffCoefficient).toBeCloseTo(s.totalRunoffVol / s.totalPrecip, 12);
      }
    } finally {
      solver.destroy();
    }
  });
});
