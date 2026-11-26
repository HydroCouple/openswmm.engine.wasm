/**
 * Real module: `solver.tables` (time series, curves) and `solver.patterns` on
 * tests/fixtures/smoke.inp, whose TS1 is a time-only (relative) series.
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

describe.skipIf(!built)(title("real module: tables and patterns"), () => {
  it("reads the deck's time series as dated rows with relative metadata", async () => {
    const { pkg, solver } = await opened();
    try {
      const { tables } = solver;
      expect(tables.length).toBe(1);
      expect(tables.has("TS1")).toBe(true);
      expect(tables.has("nope")).toBe(false);
      expect(tables.getType("TS1")).toBe(pkg.TableType.TIMESERIES);
      const ts = tables.asTimeseries("TS1");
      expect(ts.id).toBe("TS1");
      expect(ts.length).toBe(7);
      const [relative, anchor] = ts.relativeInfo;
      expect(relative).toBe(7);
      const rows = ts.points;
      expect(rows[0][0].getTime()).toBe(pkg.oadateToDatetime(anchor).getTime());
      expect(rows[2][0].getTime() - rows[0][0].getTime()).toBe(30 * 60 * 1000);
      expect(rows.map(([, v]) => v)).toEqual([0, 0.5, 1, 0.75, 0.5, 0.25, 0]);
      expect(ts.lookup(anchor + 22.5 / 1440)).toBeCloseTo(0.75, 12); // halfway 0:15 -> 0:30
      expect([...tables].map((t) => t.id)).toEqual(["TS1"]);
    } finally {
      solver.destroy();
    }
  });

  it("adds, edits, replaces and renames tables before initialization", async () => {
    const { pkg, solver } = await opened();
    try {
      const { tables } = solver;
      const curve = tables.addCurve("C1");
      curve.addPoint(0, 0);
      curve.addPoint(2, 10);
      expect(curve.points).toEqual([
        [0, 0],
        [2, 10],
      ]);
      expect(curve.lookup(1)).toBe(5);
      curve.validatePoints([[0, 1]]);
      expect(curve.length).toBe(2); // validation does not change the table
      curve.replacePoints([
        [0, 1],
        [4, 3],
      ]);
      expect(curve.lookup(2)).toBe(2);

      const ts = tables.addTimeseries("TS2");
      ts.add(new Date(Date.UTC(2026, 0, 1, 6)), 4);
      expect(ts.points).toEqual([[new Date(Date.UTC(2026, 0, 1, 6)), 4]]);
      ts.clear();
      expect(ts.length).toBe(0);

      tables.rename("C1", "C1b");
      expect(curve.id).toBe("C1b"); // indices do not move: the view follows
      expect(() => curve.replacePoints([[0, 0]])).toThrow(pkg.StaleObjectError);
      expect(tables.getId(curve.index)).toBe("C1b");
      expect(() => tables.get(99)).toThrow(pkg.ElementNotFoundError);
    } finally {
      solver.destroy();
    }
  });

  it("refuses creation after initialization with the states that allow it", async () => {
    const { pkg, solver } = await opened();
    try {
      solver.initialize();
      expect(() => solver.tables.addCurve("late")).toThrow(/BUILDING or OPENED/);
      expect(() => solver.patterns.add("late")).toThrow(pkg.LifecycleError);
    } finally {
      solver.destroy();
    }
  });

  it("adds, edits, renames and removes patterns", async () => {
    const { pkg, solver } = await opened();
    try {
      const { patterns } = solver;
      const monthly = patterns.add("M", pkg.PatternType.MONTHLY);
      expect(monthly.type).toBe(pkg.PatternType.MONTHLY);
      const factors = Array.from({ length: 12 }, (_, i) => 1 + i / 10);
      monthly.setFactors(factors);
      expect(monthly.factors).toEqual(factors);
      patterns.add("H");
      patterns.rename("M", "Monthly");
      expect(patterns.getIndex("Monthly")).toBe(monthly.index);
      expect([...patterns].map((p) => p.id)).toEqual(["Monthly", "H"]);
      patterns.remove("Monthly");
      expect(patterns.length).toBe(1);
      expect(() => monthly.id).toThrow(pkg.StaleObjectError); // indices shifted
      expect(patterns.get(-1).id).toBe("H");
    } finally {
      solver.destroy();
    }
  });
});
