/**
 * Real module, wave C part 4: hot start files, the save schedule and
 * checkpoint sessions on tests/fixtures/smoke.inp.
 *
 * Checkpoint saving needs an atomic no-replace rename that the engine only
 * compiles for Windows, macOS and Linux (io/CheckpointDirectory.cpp), so this
 * build reports no SAVE_NEW / BUNDLE_EXPORT capability and save() refuses; the
 * test pins that until the engine gains an Emscripten branch.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { built, fixtures, load, title, work } from "./load.js";

const SAVE_NEW = 1 << 2;
const BUNDLE_EXPORT = 1 << 7;

async function opened(out = "/smoke.out") {
  const { mod, pkg } = await load();
  const solver = new pkg.Solver(mod);
  solver.writeFile("/smoke.inp", readFileSync(resolve(fixtures, "smoke.inp"), "utf8"));
  solver.open("/smoke.inp", "/smoke.rpt", out);
  return { mod, pkg, solver };
}

describe.skipIf(!built)(title("real module: wave C part 4"), () => {
  it("saves, reads, edits and applies a hot start file", async () => {
    const { mod, pkg, solver } = await opened();
    try {
      solver.initialize();
      solver.start(true);
      solver.until(1800);
      pkg.HotStart.saveFrom(solver, "/run.hsf");
      writeFileSync(resolve(work, "wave_c4.hsf"), solver.readFile("/run.hsf"));

      const hs = pkg.HotStart.open(mod, "/run.hsf");
      try {
        expect(hs.version).toBeGreaterThan(0);
        expect(hs.nodeCount).toBe(solver.nodes.length);
        expect(hs.linkCount).toBe(solver.links.length);
        expect(hs.subcatchmentCount).toBe(solver.subcatchments.length);
        expect(hs.startDatetime.getTime()).toBe(solver.simStartTime.getTime());
        expect(hs.simDatetime.getTime() - hs.startDatetime.getTime()).toBeGreaterThanOrEqual(
          1800 * 1000,
        );
        expect(hs.savedAt).toBeInstanceOf(Date);
        expect(hs.crs).toBeNull();
        const nodes = hs.nodeRecords();
        expect(nodes.map((n) => n.id)).toEqual(solver.nodes.ids);
        expect(nodes[0].depth).toBeCloseTo(solver.nodes.get(0).depth, 9);
        expect(hs.linkRecords()[0].id).toBe(solver.links.getId(0));
        expect(hs.subcatchmentRecords()[0].id).toBe("S1");
        hs.setNodeDepth("J1", 0.75);
        expect(hs.nodeRecords()[0].depth).toBe(0.75);
      } finally {
        hs.close();
      }
      expect(() => hs.nodeCount).toThrow(pkg.StaleObjectError);
      expect(() => pkg.HotStart.open(mod, "/missing.hsf")).toThrow(pkg.EngineError);

      const fresh = new pkg.Solver(mod);
      try {
        fresh.open("/smoke.inp", "/fresh.rpt", "/fresh.out");
        fresh.initialize();
        using again = pkg.HotStart.open(mod, "/run.hsf");
        again.apply(fresh);
      } finally {
        fresh.destroy();
      }
    } finally {
      solver.destroy();
    }
  });

  it("edits the [SAVE HOTSTART] schedule", async () => {
    const { pkg, solver } = await opened();
    try {
      const sched = solver.saveSchedule;
      const t = (h: number) => new Date(Date.UTC(2026, 0, 1, h));
      sched.append({ when: t(1), path: "/h1.hsf" });
      sched.append([t(3), "/h3.hsf"]);
      sched.setFormat(1, "native");
      sched.insert(1, { when: t(2), path: "/h2.hsf" });
      expect([...sched].map((e) => e.path)).toEqual(["/h1.hsf", "/h2.hsf", "/h3.hsf"]);
      expect(sched.getFormat(2)).toBe("NATIVE"); // insert keeps the formats
      sched.set(0, [t(0), "/h0.hsf"]);
      expect(sched.get(0).when.getTime()).toBe(t(0).getTime());
      sched.delete(-1);
      expect(sched.length).toBe(2);
      expect(() => sched.setFormat(0, "zip")).toThrow(pkg.BadParamError);
      expect(Array.isArray(sched.legacyOmits())).toBe(true);
      sched.clear();
      expect(sched.length).toBe(0);
    } finally {
      solver.destroy();
    }
  });

  it("starts a checkpoint session; saving waits for an engine publication primitive", async () => {
    const { pkg, solver } = await opened("");
    try {
      const cp = solver.checkpoints;
      const caps = cp.capabilities;
      expect(caps & 1).toBe(1); // inspection
      expect(caps & SAVE_NEW).toBe(0);
      expect(caps & BUNDLE_EXPORT).toBe(0);
      cp.startSession(0);
      expect(cp.sessionStatus & 1).toBe(1); // attached
      solver.until(600);
      expect(() => cp.save("/cp.chk")).toThrow(/Exclusive checkpoint publication unavailable/);
      expect(() => pkg.Checkpoints.exportBundle(solver.module, "/cp.chk", "/bundle")).toThrow(
        pkg.EngineError,
      );
    } finally {
      solver.destroy();
    }
  });
});
