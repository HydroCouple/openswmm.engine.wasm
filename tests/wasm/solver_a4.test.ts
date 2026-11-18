/**
 * Real module: Python `Solver` members added in wave A4 — options, user
 * flags, events, stepping helpers, callbacks, writers, partial opens and the
 * module-level `abiTag` / `run` / `runWithCallback` — on tests/fixtures/smoke.inp.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { built, fixtures, load, title, work } from "./load.js";

const deck = () => readFileSync(resolve(fixtures, "smoke.inp"), "utf8");

async function opened() {
  const { mod, pkg } = await load();
  const solver = new pkg.Solver(mod);
  solver.writeFile("/smoke.inp", deck());
  solver.open("/smoke.inp", "/smoke.rpt", "/smoke.out");
  return { mod, pkg, solver };
}

describe.skipIf(!built)(title("real module: Solver (wave A4)"), () => {
  it("reads and writes [OPTIONS] by key and through the typed shortcuts", async () => {
    const { pkg, solver } = await opened();
    try {
      const { options } = solver;
      expect(options.get("FLOW_UNITS")).toBe("CFS");
      expect(options.has("FLOW_UNITS")).toBe(true);
      expect(options.has("NOT_AN_OPTION")).toBe(false);
      expect(() => options.get("NOT_AN_OPTION")).toThrow(pkg.ElementNotFoundError);
      expect(() => options.delete("FLOW_UNITS")).toThrow(TypeError);
      const keys = [...options];
      expect(keys.length).toBe(options.length);
      expect(keys).toContain("ROUTING_STEP");
      expect(options.ext.length).toBe([...options.ext].length);

      const start = new Date(Date.UTC(2030, 4, 6, 7, 8, 9));
      options.startDatetime = start;
      expect(solver.startDatetime.getTime()).toBe(start.getTime());
      const report = new Date(Date.UTC(2030, 4, 6, 12));
      solver.reportStartDatetime = report;
      expect(options.reportStartDatetime.getTime()).toBe(report.getTime());
      expect(solver.simStartTime).toBeInstanceOf(Date);
      expect(solver.unitSystem).toBe("US");
      expect(() => options.crs).toThrow(pkg.CRSError); // no CRS configured (SWMM_ERR_CRS), as in Python
      options.set("CRS", "EPSG:32633");
      expect(solver.crs).toBe("EPSG:32633");
      solver.steadyStateSkip = true;
      expect(solver.steadyStateSkip).toBe(true);
      expect(solver.generation).toBeGreaterThan(0);
    } finally {
      solver.destroy();
    }
  });

  it("defines, sets, reads and removes user flags", async () => {
    const { pkg, solver } = await opened();
    try {
      const flags = solver.userflags;
      flags.define("CALIBRATED", pkg.UserFlagType.BOOLEAN, "calibration done");
      expect(flags.definitions()).toEqual([
        { name: "CALIBRATED", type: pkg.UserFlagType.BOOLEAN, description: "calibration done" },
      ]);
      flags.set("CALIBRATED", true); // the typed setter re-declares the flag (engine behavior)
      expect(flags.get("CALIBRATED")).toBe(true);
      flags.define("ZONE", pkg.UserFlagType.INTEGER);
      flags.set("ZONE", 7);
      expect(flags.get("ZONE")).toBe(7);
      flags.define("FACTOR", pkg.UserFlagType.REAL);
      flags.set("FACTOR", 2); // declared REAL: a whole number stays REAL
      expect(flags.get("FACTOR")).toBe(2);
      flags.set("OWNER", "city");
      expect(flags.get("OWNER")).toBe("city");
      expect([...flags]).toEqual(["CALIBRATED", "ZONE", "FACTOR", "OWNER"]);
      expect(flags.definitions().map((d) => [d.name, d.type])).toEqual([
        ["CALIBRATED", pkg.UserFlagType.BOOLEAN],
        ["ZONE", pkg.UserFlagType.INTEGER],
        ["FACTOR", pkg.UserFlagType.REAL],
        ["OWNER", pkg.UserFlagType.STRING],
      ]);

      flags.setValue("NODE", "J1", "ZONE", "3");
      expect(flags.getValue("NODE", "J1", "ZONE")).toBe("3");
      flags.clearValue("NODE", "J1", "ZONE");
      expect(flags.getValue("NODE", "J1", "ZONE")).toBeNull();

      flags.delete("OWNER");
      expect(flags.has("OWNER")).toBe(false);
      expect(() => flags.delete("OWNER")).toThrow(pkg.ElementNotFoundError);
    } finally {
      solver.destroy();
    }
  });

  it("edits the [EVENTS] list", async () => {
    const { pkg, solver } = await opened();
    try {
      const { events } = solver;
      const day = (d: number, h = 0) => new Date(Date.UTC(2026, 0, d, h));
      events.append({ start: day(1), end: day(1, 6) });
      events.append([day(3), day(3, 6)]);
      events.insert(1, { start: day(2), end: day(2, 6) });
      expect([...events].map((e) => e.start.getUTCDate())).toEqual([1, 2, 3]);
      expect(solver.eventCount).toBe(3);
      events.set(-1, [day(4), day(4, 1)]);
      expect(events.get(2).end.getTime()).toBe(day(4, 1).getTime());
      events.delete(0);
      expect(events.length).toBe(2);
      expect(() => events.get(5)).toThrow(pkg.ElementNotFoundError);
      events.clear();
      expect(events.length).toBe(0);
    } finally {
      solver.destroy();
    }
  });

  it("steps with until/advanceTo/steps and fires every callback", async () => {
    const { solver } = await opened();
    try {
      const seen = { progress: 0, begin: 0, end: 0, phase: 0 };
      solver.setProgressCallback(() => seen.progress++);
      solver.setStepBeginCallback(() => seen.begin++);
      solver.setStepEndCallback(() => seen.end++);
      solver.setPhaseCallback(() => seen.phase++);
      solver.initialize();
      solver.start(true);
      expect(solver.until(600)).toBeGreaterThanOrEqual(600);
      expect(solver.elapsed).toBeGreaterThanOrEqual(600);
      expect(solver.advanceTo(1800)).toBeGreaterThanOrEqual(1800);
      let last = 0;
      for (const elapsed of solver.steps()) last = elapsed;
      expect(last).toBeGreaterThan(1800);
      solver.end();
      expect(seen.begin).toBeGreaterThan(0);
      expect(seen.end).toBe(seen.begin);
      expect(seen.progress).toBeGreaterThan(0);
      solver.setStepEndCallback(null);
    } finally {
      solver.destroy();
    }
  });

  it("rethrows a callback's error after the step that raised it", async () => {
    const { solver } = await opened();
    try {
      let calls = 0;
      solver.setStepEndCallback(() => {
        calls++;
        throw new Error("from the callback");
      });
      solver.initialize();
      solver.start(true);
      expect(() => solver.step()).toThrow("from the callback");
      expect(calls).toBe(1);
      solver.setStepEndCallback(null);
      expect(solver.step()).toBeGreaterThan(0); // the engine is still usable
    } finally {
      solver.destroy();
    }
  });

  it("writes the model directly, for EPA SWMM 5 and through a staging mapper", async () => {
    const { pkg, solver } = await opened();
    try {
      solver.write("/written.inp");
      expect(solver.readFile("/written.inp", "utf8")).toContain("[CONDUITS]");
      solver.writeCompat("/stock.inp", pkg.InpProfile.SWMM5_STOCK);
      expect(solver.readFile("/stock.inp", "utf8")).toContain("[JUNCTIONS]");
      const kinds: number[] = [];
      solver.writeStaged("/final/model.inp", (finalPath, kind) => {
        kinds.push(kind);
        return finalPath.replace("/final/", "/staging-");
      });
      expect(kinds).toContain(0);
      writeFileSync(resolve(work, "solver_a4.staged.inp"), solver.readFile("/staging-model.inp"));
      expect(() =>
        solver.writeStaged("/final/x.inp", () => {
          throw new Error("mapper failed");
        }),
      ).toThrow("mapper failed");
    } finally {
      solver.destroy();
    }
  });

  it("opens only metadata or the simulation period", async () => {
    const { mod, pkg } = await load();
    const solver = new pkg.Solver(mod);
    try {
      solver.writeFile("/smoke.inp", deck());
      solver.openMetadata("/smoke.inp");
      expect(solver.nodes.length).toBeGreaterThan(0);
      solver.close();
      solver.openSimulationPeriod("/smoke.inp");
      expect(solver.endDatetime.getTime()).toBeGreaterThan(solver.startDatetime.getTime());
      expect(solver.openErrors).toEqual([]);
      expect(Array.isArray(solver.openWarnings)).toBe(true);
    } finally {
      solver.destroy();
    }
  });

  it("runs whole simulations with run / runWithCallback and reports the ABI tag", async () => {
    const { mod, pkg } = await load();
    mod.FS.writeFile("/smoke.inp", deck());
    pkg.run(mod, "/smoke.inp", "/run.rpt", "/run.out");
    expect(new TextDecoder().decode(mod.FS.readFile("/run.rpt"))).toContain("Continuity Error");
    const fractions: number[] = [];
    pkg.runWithCallback(mod, "/smoke.inp", "/cb.rpt", "/cb.out", (f) => fractions.push(f));
    expect(fractions.length).toBeGreaterThan(0);
    expect(Math.max(...fractions)).toBeLessThanOrEqual(1);
    expect(() =>
      pkg.runWithCallback(mod, "/smoke.inp", "/cb2.rpt", "/cb2.out", () => {
        throw new Error("stop");
      }),
    ).toThrow("stop");
    expect(pkg.abiTag(mod)).toMatch(/\S/);
  });
});
