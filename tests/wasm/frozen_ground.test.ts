/**
 * Real module: frozen-ground rows and slab state (engine 80e19614), following
 * python/tests/engine/test_frozen_ground.py, plus the mesh state readout on
 * the runtime-coupling surface deck.
 *
 * Results go to tests/_work/wasm/fg/frozen_ground.json for
 * tests/_work/wasm/fg/crosscheck.py (run by hand with native Python).
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { built, load, title, work } from "./load.js";
import { FROZEN_GROUND_MODEL, RUNTIME_SURFACE_MODEL } from "./decks.js";

const FROZEN = [0.15, 1.5, 2.4e6, 0.3, 8.0, 3.0, -4.0, 11.0, 0.25, 250.0];

async function opened(text = FROZEN_GROUND_MODEL) {
  const { mod, pkg } = await load();
  const solver = new pkg.Solver(mod);
  solver.writeFile("/frozen.inp", text);
  solver.open("/frozen.inp", "/frozen.rpt", "/frozen.out");
  return { pkg, solver };
}

describe.skipIf(!built)(title("real module: frozen ground"), () => {
  const evidence: Record<string, unknown> = {};
  afterAll(() => {
    const out = resolve(work, "fg");
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "frozen_ground.json"), JSON.stringify(evidence, null, 1) + "\n");
  });

  it("authors and reads back rows of both sections", async () => {
    const { pkg, solver } = await opened();
    try {
      expect(solver.frozenGroundRows()).toEqual({});
      solver.setFrozenGround("*", FROZEN);
      solver.setFrozenGround("S1", [...FROZEN.slice(0, 6), 2.0, ...FROZEN.slice(7)]);
      const rows = solver.frozenGroundRows();
      expect(Object.keys(rows)).toEqual(["*", "S1"]);
      expect(rows["*"]).toEqual(FROZEN);
      expect(rows.S1[6]).toBe(2.0);
      solver.removeFrozenGround("S1");
      expect(Object.keys(solver.frozenGroundRows())).toEqual(["*"]);
      expect(() => solver.removeFrozenGround("S1")).toThrow(pkg.EngineError);
      expect(() => solver.setFrozenGround("S1", [-1.0, ...FROZEN.slice(1)])).toThrow(
        pkg.EngineError,
      );
      expect(() => solver.setFrozenGround("S1", FROZEN.slice(0, 4))).toThrow(RangeError);
      solver.setFrozenGround("*", FROZEN, true);
      solver.setFrozenGround("LAWN", FROZEN, true);
      expect(solver.frozenGroundRows(true)).toEqual({ "*": FROZEN, LAWN: FROZEN });
      expect(() => solver.setFrozenGround("", FROZEN, true)).toThrow(pkg.EngineError);
    } finally {
      solver.destroy();
    }
  });

  it("reports no state for a subcatchment without a row", async () => {
    const { solver } = await opened();
    try {
      solver.initialize();
      expect(solver.subcatchments.get(0).frozenGround).toBeNull();
    } finally {
      solver.destroy();
    }
  });

  it("reports the slab state and takes no water through frozen ground", async () => {
    const { solver } = await opened();
    try {
      solver.setFrozenGround("S1", FROZEN);
      solver.initialize();
      const s1 = solver.subcatchments.get(0);
      expect(s1.frozenGround).toEqual([-4.0, 1.0, 0.0]);
      solver.start();
      let rain = 0;
      let infiltration = 0;
      for (const _ of solver.steps()) {
        rain = Math.max(rain, s1.rainfall);
        infiltration = Math.max(infiltration, s1.infil);
      }
      const [temperature, frozen, factor] = s1.frozenGround as number[];
      expect(temperature).toBeLessThan(0);
      expect([frozen, factor]).toEqual([1.0, 0.0]);
      expect(rain).toBeGreaterThan(0);
      expect(infiltration).toBe(0);
      evidence.subcatchment = { state: s1.frozenGround, rain, infiltration };
    } finally {
      solver.destroy();
    }
  });

  it("reads the frozen-ground state of every mesh cell", async () => {
    const { solver } = await opened(RUNTIME_SURFACE_MODEL);
    try {
      solver.initialize();
      const bare = solver.surface2d.infiltration.frozenGround().map((a) => Array.from(a));
      expect(bare).toEqual([
        [0, 0],
        [0, 0],
        [1, 1],
      ]);
      solver.close();
      solver.open("/frozen.inp", "/frozen.rpt", "/frozen.out");
      solver.setFrozenGround("*", FROZEN, true);
      solver.initialize();
      const frozen = solver.surface2d.infiltration.frozenGround().map((a) => Array.from(a));
      expect(frozen.every((column) => column.length === 2)).toBe(true);
      evidence.mesh = { bare, frozen };
    } finally {
      solver.destroy();
    }
  });
});
