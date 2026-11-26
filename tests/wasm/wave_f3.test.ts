/**
 * Real module, wave F part 3: passive exchange snapshots
 * (`solver.passive_exchange`) and the material peer's refusals
 * (`solver.material_split`), following
 * python/tests/engine/test_passive_material.py on
 * tests/unit/engine/data/passive_exchange_c/positive.inp.
 *
 * Checkpoints save and restore the passive state, as in the Python test.
 * The material peer needs an engine built with HydroCouple
 * (OPENSWMM_HAS_HYDROCOUPLE), which the wasm build is not; its paired run is
 * skipped there, as in the Python test.
 *
 * Results go to tests/_work/wasm/f3/wave_f3.json for
 * tests/_work/wasm/f3/crosscheck.py (run by hand with native Python).
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { built, load, title, work } from "./load.js";
import { PASSIVE_DECK } from "./decks.js";

const MAX_U64 = 2n ** 64n - 1n;

async function engine() {
  const { mod, pkg } = await load();
  const solver = new pkg.Solver(mod);
  solver.writeFile("/native.inp", PASSIVE_DECK);
  solver.open("/native.inp", "/native.rpt", "");
  return { mod, pkg, solver };
}

describe.skipIf(!built)(
  title("real module: wave F part 3 (passive exchange, material peer)"),
  () => {
    const evidence: Record<string, unknown> = {};
    afterAll(() => {
      const out = resolve(work, "f3");
      mkdirSync(out, { recursive: true });
      writeFileSync(resolve(out, "wave_f3.json"), JSON.stringify(evidence, null, 1) + "\n");
    });

    it("refuses passive calls with typed errors and expires the view", async () => {
      const { mod, pkg } = await load();
      const solver = new pkg.Solver(mod);
      const view = solver.passiveExchange;
      try {
        expect(() => view.enable(0)).toThrow(/Capacity/);
        expect(() => view.enable(64, 2)).toThrow(/preflight/);
        for (const call of [
          () => view.status(),
          () => view.pool(0),
          () => view.receipt(0),
          () => view.row(0, 0),
          () => view.leg(0),
          () => view.attempt(),
          () => view.enableCheckpoint(),
          () => view.enable(64),
        ]) {
          expect(call).toThrow(pkg.LifecycleError);
        }
        expect(() => view.receipt(2 ** 64 - 1)).toThrow(RangeError); // not a safe integer
        expect(() => view.leg(-1)).toThrow(RangeError);
        expect(() => view.enable(2n ** 64n)).toThrow(RangeError);
      } finally {
        solver.destroy();
      }
      expect(() => view.status()).toThrow(pkg.EngineError);
    });

    it("copies snapshots with exact amount components", async () => {
      const { pkg, solver } = await engine();
      try {
        solver.initialize();
        solver.start(false);
        const exchange = solver.passiveExchange;
        exchange.enable(64);
        exchange.enableCheckpoint();
        expect(exchange.status().checkpointAttached).toBe(1);
        const initial = exchange.pool(0);
        expect(Array.isArray(initial.roundoff.components)).toBe(true);
        for (let i = 0; i < 8; i++) solver.step();
        const status = exchange.status();
        expect(status.receiptCount).toBeGreaterThan(0);
        expect(status.legCount).toBeGreaterThan(0);
        expect(status.failed).toBe(0);
        const receipt = exchange.receipt(0);
        expect(receipt.rowCount).toBeGreaterThan(0);
        const original = exchange.row(0, 0);
        const remaining = exchange.row(0n, 0n, 1);
        expect(original.point).toBe(remaining.point);
        expect(original.units).toBe(status.units);
        const leg = exchange.leg(receipt.firstLeg);
        expect(leg.sealed && leg.applied).toBeTruthy();
        expect(leg.point).toBe(original.point);
        const attempt = exchange.attempt();
        expect(attempt.durationSeconds).toBeGreaterThanOrEqual(0);
        for (const call of [
          () => exchange.pool(-1),
          () => exchange.receipt(MAX_U64),
          () => exchange.row(0, 0, 2),
          () => exchange.leg(MAX_U64),
        ]) {
          expect(call).toThrow(pkg.EngineError);
          expect(exchange.status()).toEqual(status);
        }
        expect(exchange.pool(0)).not.toEqual(initial);
        evidence.snapshots = {
          initial,
          status,
          pool: exchange.pool(0),
          receipt,
          original,
          remaining,
          leg,
          attempt,
        };
        solver.checkpoints.save("/passive checkpoint.bin");
        const restored = new pkg.Solver(solver.module);
        try {
          restored.open("/native.inp", "/restored.rpt", "");
          restored.initialize();
          restored.start(false);
          restored.passiveExchange.enable(64);
          restored.passiveExchange.enableCheckpoint();
          restored.checkpoints.restore("/passive checkpoint.bin");
          expect(restored.passiveExchange.status()).toEqual(exchange.status());
          expect(restored.passiveExchange.pool(0)).toEqual(exchange.pool(0));
          evidence.checkpoint = { restoredStatus: restored.passiveExchange.status() };
        } finally {
          restored.destroy();
        }
      } finally {
        solver.destroy();
      }
    });

    it("refuses passive inspection inside a callback", async () => {
      const { pkg, solver } = await engine();
      try {
        solver.initialize();
        solver.start(false);
        solver.passiveExchange.enable(64);
        const seen: boolean[] = [];
        solver.setStepBeginCallback(() => {
          expect(() => solver.passiveExchange.status()).toThrow(pkg.LifecycleError);
          seen.push(true);
        });
        solver.step();
        expect(seen.length).toBeGreaterThan(0);
      } finally {
        solver.destroy();
      }
    });

    it("rejects invalid material packet buffers before native code", async () => {
      const { mod, pkg } = await load();
      const solver = new pkg.Solver(mod);
      try {
        for (const text of ["", "{}\0", "x".repeat(64 * 1024 * 1024 + 1)]) {
          expect(() => solver.materialSplit.decode(text)).toThrow(/Material packet/);
          expect(() => solver.materialSplit.copyPacket(text)).toThrow(/Material packet/);
        }
        expect(() => solver.materialSplit.copyPacket(42 as unknown as string)).toThrow(TypeError);
      } finally {
        solver.destroy();
      }
    });

    it("reports material feature and lifecycle errors", async () => {
      const { mod, pkg } = await load();
      const solver = new pkg.Solver(mod);
      try {
        const material = solver.materialSplit;
        for (const call of [
          () => material.validateInput(),
          () => material.configure(pkg.SplitRole.NETWORK),
          () => material.setTransport((_stage, text) => text),
          () => material.copyPacket("{}"),
          () => material.decode("{}"),
        ]) {
          expect(call).toThrow(pkg.EngineError);
        }
        expect(() => material.setTransport(null as unknown as () => string)).toThrow(TypeError);
        expect(material.checkpointCapabilities()).toBeGreaterThanOrEqual(0);
      } finally {
        solver.destroy();
      }
    });

    it("runs a material pair where the build supports it", async () => {
      const { pkg, solver: network } = await engine();
      try {
        try {
          network.materialSplit.validateInput();
        } catch (err) {
          expect(err).toBeInstanceOf(pkg.PluginError);
          evidence.material = `unavailable: ${(err as Error).message}`;
          evidence.materialCheckpointCapabilities = network.materialSplit.checkpointCapabilities();
          return;
        }
        throw new Error(
          "this build supports the material peer: add the paired run of the Python test",
        );
      } finally {
        network.destroy();
      }
    });
  },
);
