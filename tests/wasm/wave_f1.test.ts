/**
 * Real module, wave F part 1: runtime exchange sources, boundaries, forcing,
 * providers and receipts (`solver.coupling`, `surface2d.sources`,
 * `groundwater2d.sources`), following python/tests/engine/test_runtime_sources.py
 * on its surface and mixed-cell groundwater models.
 *
 * Results go to tests/_work/wasm/f1/wave_f1.json for
 * tests/_work/wasm/f1/crosscheck.py (run by hand with native Python).
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { built, load, title, work } from "./load.js";
import { MIXED_CELL_MODEL, RUNTIME_SURFACE_MODEL } from "./decks.js";

interface Options {
  groundwater?: boolean;
  heat?: boolean;
  closure?: string;
  momentum?: string;
}

/** The `model()` fixture of the Python test: opened, initialized and started. */
async function runtime({
  groundwater = false,
  heat = false,
  closure = "CLOSED_FORM",
  momentum = "LOCAL_INERTIAL",
}: Options = {}) {
  const { mod, pkg } = await load();
  let text = groundwater
    ? MIXED_CELL_MODEL.replaceAll("0.03 0.1", "0.03 0")
    : RUNTIME_SURFACE_MODEL;
  text = text
    .split("\n")
    .filter((l) => !l.trim().startsWith("MOMENTUM_EQUATION"))
    .join("\n")
    .replace("[2D_OPTIONS]", `[2D_OPTIONS]\nMOMENTUM_EQUATION ${momentum}`);
  if (heat) text = text.replace("[OPTIONS]", "[OPTIONS]\nHEAT_TRANSPORT YES");
  const solver = new pkg.Solver(mod);
  solver.writeFile("/runtime.inp", text);
  solver.open("/runtime.inp", "/runtime.rpt", "/runtime.out");
  if (groundwater) {
    const gw = solver.groundwater2d;
    gw.options.set("NODE_ENROLMENT", "ROWS");
    gw.options.set("CLOSURE", closure);
    gw.addRow({
      scope: pkg.CellScope.GLOBAL,
      ks: 36,
      zs: 0.5,
      thetaS: 0.45,
      thetaR: 0.1,
      alpha: 2,
    });
    gw.setRowProperty(0, "HG0", 0.2);
    gw.transport.options.set("TRANSPORT_POLLUTANTS", "YES");
    if (heat) gw.transport.options.set("TRANSPORT_TEMPERATURE", "YES");
  }
  solver.initialize();
  solver.start();
  return { mod, pkg, solver };
}

const sum = (values: ArrayLike<number>) => Array.from(values).reduce((a, b) => a + b, 0);

describe.skipIf(!built)(title("real module: wave F part 1 (runtime coupling)"), () => {
  const evidence: Record<string, unknown> = {};
  afterAll(() => {
    const out = resolve(work, "f1");
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "wave_f1.json"), JSON.stringify(evidence, null, 1) + "\n");
  });

  it("replaces, clears and receipts surface sources at exact clock points", async () => {
    const { solver } = await runtime();
    try {
      const sw = solver.surface2d;
      solver.advanceTo(2.375);
      sw.setWaterSource([0, 1], [0.01, 0.02], { concentrations: { TSS: 7 } });
      expect(solver.advanceTo(13.625)).toBe(13.625);
      expect(sw.totalVolume).toBeCloseTo(0.03 * 11.25, 12);
      for (const c of sw.concentrations(sw.species.indexOf("TSS"))) expect(c).toBeCloseTo(7, 9);
      const first = sw.sourceReceipt("external", 0);
      expect(first.appliedM3).toBeCloseTo(0.1125, 12);
      sw.setWaterSource([0, 1], [0.02, 0.03], { concentrations: { TSS: 7 } });
      solver.advanceTo(17.875);
      sw.clearSource();
      const held = sw.totalVolume;
      solver.advanceTo(23.125);
      expect(sw.totalVolume).toBeCloseTo(held, 12);
      const receipt = sw.sourceReceipt("external", 0);
      expect(receipt.appliedM3).toBeCloseTo(0.1125 + 0.02 * 4.25, 12);
      expect(receipt.limiterReasons).toEqual([]);
      evidence.surfaceClock = {
        first,
        receipt,
        totalVolume: sw.totalVolume,
        waterTotals: sw.sources.waterTotals,
      };
      for (const expiry of [0, -1, NaN, Infinity]) {
        expect(() => sw.setWaterSource(0, 0.001, { untilSeconds: expiry })).toThrow(
          /until_seconds/,
        );
      }
      const step = solver.elapsed;
      solver.setStepBeginCallback(() => solver.advanceTo(100));
      expect(() => solver.step()).toThrow(/lifecycle/i);
      solver.setStepBeginCallback(null);
      expect(solver.elapsed).toBeGreaterThan(step);
    } finally {
      solver.destroy();
    }
  });

  it("conserves groundwater sources and keeps invalid batches atomic", async () => {
    const { pkg, solver } = await runtime({ groundwater: true });
    try {
      const gw = solver.groundwater2d;
      expect(gw.sources.domain).toBe("groundwater");
      solver.advanceTo(7.125);
      const v0 = gw.ledger(pkg.GroundwaterLedger.STORAGE);
      gw.setWaterSource(0, 0.001, { concentrations: { TSS: 12 }, untilSeconds: 19.625 });
      solver.advanceTo(30.25);
      const r = gw.sourceReceipt();
      expect(r.appliedM3).toBeCloseTo(0.0125, 12);
      expect(gw.ledger(pkg.GroundwaterLedger.STORAGE) - v0).toBeCloseTo(r.appliedM3, 10);
      expect(r.appliedSpecies.TSS).toBeCloseTo(0.15, 10);
      expect(Math.abs(gw.continuityError)).toBeLessThan(1e-9);
      evidence.groundwaterSource = { receipt: r, continuityError: gw.continuityError };

      const source = { sourceId: "test", domain: "surface" as const, cell: 0, flowM3S: 0.001 };
      solver.coupling.setSources([{ ...source, concentrations: { TSS: 3 } }]);
      const at = solver.elapsed;
      expect(() =>
        solver.coupling.setSources([
          { ...source, flowM3S: 0.8 },
          { ...source, cell: 99 },
        ]),
      ).toThrow(pkg.BadIndexError);
      expect(solver.elapsed).toBe(at);
      solver.advanceTo(at + 5);
      expect(solver.surface2d.sourceReceipt("test").appliedM3).toBeCloseTo(0.005, 12);
      expect(() => solver.coupling.setSources([{ ...source, sourceId: "boundary/x" }])).toThrow(
        RangeError,
      );
      expect(() => solver.coupling.setSources([{ ...source, cell: 0.5 }])).toThrow(RangeError);
      expect(() =>
        solver.coupling.setSources([{ ...source, concentrations: { NOPE: 1 } }]),
      ).toThrow(/Unknown or disabled species/);
    } finally {
      solver.destroy();
    }
  });

  it("supplies heat and independent species and refuses heat without temperature", async () => {
    const cold = await runtime();
    try {
      expect(() => cold.solver.surface2d.setHeatSource(0, 10)).toThrow(/temperature transport/);
    } finally {
      cold.solver.destroy();
    }
    const { solver } = await runtime({ heat: true });
    try {
      const sw = solver.surface2d;
      solver.advanceTo(1.25);
      sw.setWaterSource(0, 0.1, { concentrations: { __TEMPERATURE__: 10, TSS: 2 } });
      sw.setHeatSource(0, 4186);
      sw.setSpeciesSource(0, { TSS: 0.003 });
      solver.advanceTo(11.25);
      const heat = sw.sourceReceipt("heat");
      const species = sw.sourceReceipt("species");
      expect(heat.appliedHeatJ).toBeCloseTo(41860, 6);
      expect(species.appliedSpecies.TSS).toBeCloseTo(0.03, 12);
      const depths = sw.getDepths();
      const volume = Array.from(depths, (d, i) => d * sw.getTriangleArea(i));
      const mass = (name: string) =>
        sum(Array.from(sw.concentrations(sw.species.indexOf(name)), (c, i) => c * volume[i]));
      expect(mass("TSS")).toBeCloseTo(2.03, 10);
      expect(mass("__TEMPERATURE__")).toBeCloseTo(10.01, 10);
      evidence.heatSpecies = {
        heat,
        species,
        tss: mass("TSS"),
        temperature: mass("__TEMPERATURE__"),
      };
    } finally {
      solver.destroy();
    }
  });

  it("applies, receipts and clears groundwater flow boundaries with quality", async () => {
    const { pkg, solver } = await runtime({ groundwater: true, heat: true });
    try {
      const gw = solver.groundwater2d;
      const total = () => gw.ledger(pkg.GroundwaterLedger.STORAGE) + solver.surface2d.totalVolume;
      solver.advanceTo(1.375);
      const before = total();
      gw.setFlowBoundary(0, 0, -0.01, { TSS: 8, __TEMPERATURE__: 12 });
      solver.advanceTo(11.375);
      const after = total();
      expect(after - before).toBeCloseTo(0.1, 9);
      const r = gw.boundaryReceipt(0, 0);
      expect(r.appliedSpecies.TSS).toBeCloseTo(0.8, 9);
      expect(r.appliedSpecies.__TEMPERATURE__).toBeCloseTo(1.2, 9);
      const flowing = gw.boundaryFlow(0, 0);
      gw.clearBoundary(0, 0);
      solver.advanceTo(16.375);
      expect(gw.boundaryFlow(0, 0)).toBe(0);
      expect(total()).toBeCloseTo(after, 9);
      evidence.groundwaterBoundary = { receipt: r, flowing, change: after - before };
    } finally {
      solver.destroy();
    }
  });

  it("keeps gross surface boundary ledgers and receipts separate", async () => {
    const { solver } = await runtime({ heat: true });
    try {
      const sw = solver.surface2d;
      sw.setWaterSource([0, 1], 0.1, { concentrations: { TSS: 3, __TEMPERATURE__: 12 } });
      solver.advanceTo(2);
      sw.clearSource();
      sw.setFlowBoundary(0, 0, -0.01, { TSS: 3, __TEMPERATURE__: 12 });
      sw.setFlowBoundary(0, 2, 0.01);
      solver.advanceTo(12);
      const mb = sw.getMassBalance();
      expect(mb.boundaryIn).toBeCloseTo(0.1, 12);
      expect(mb.boundaryOut).toBeCloseTo(0.1, 12);
      expect(Math.abs(mb.continuityError)).toBeLessThan(1e-9);
      const incoming = sw.boundaryReceipt(0, 0);
      const outgoing = sw.boundaryReceipt(0, 2);
      expect(incoming.appliedM3).toBeCloseTo(0.1, 12);
      expect(outgoing.appliedM3).toBeCloseTo(-0.1, 12);
      expect(incoming.appliedSpecies.TSS).toBeCloseTo(0.3, 12);
      expect(outgoing.appliedSpecies.TSS).toBeCloseTo(-0.3, 12);
      expect(incoming.appliedHeatJ).toBeCloseTo(1.2 * 4186000, 4);
      const ledger = sw.speciesLedger("TSS");
      expect(ledger.boundaryIn).toBeCloseTo(0.3, 12);
      expect(ledger.boundaryOut).toBeCloseTo(0.3, 12);
      expect(() => sw.speciesLedger("NOPE")).toThrow(RangeError);
      evidence.grossBoundary = { incoming, outgoing, ledger, boundaryFlow: sw.boundaryFlow(0, 0) };
    } finally {
      solver.destroy();
    }
  });

  it("applies atomic provider frames with selective clears", async () => {
    const { pkg, solver } = await runtime({ groundwater: true });
    try {
      const a = solver.coupling.forProvider("a");
      const b = solver.coupling.forProvider("b");
      expect(a.providerId).toBe("a");
      expect(() => solver.coupling.forProvider("x/y")).toThrow(RangeError);
      a.applyFrame({
        sources: [
          { sourceId: "x", domain: "surface", cell: 0, flowM3S: 0.01, concentrations: { TSS: 2 } },
          { sourceId: "x", domain: "surface", cell: 1, flowM3S: 0.02, concentrations: { TSS: 2 } },
          {
            sourceId: "x",
            domain: "groundwater",
            cell: 0,
            flowM3S: 0.001,
            concentrations: { TSS: 2 },
          },
        ],
        boundaries: [
          {
            domain: "surface",
            cell: 0,
            edge: 0,
            kind: 2,
            value: -0.001,
            concentrations: { TSS: 2 },
          },
        ],
        forcings: [{ channel: "rainfall", cell: -1, rateMS: 0.00001, concentrations: { TSS: 2 } }],
      });
      b.surface.setSource(0, 0.003, { sourceId: "x" });
      expect(() =>
        b.applyFrame({
          sources: [{ sourceId: "bad", domain: "surface", cell: 0, flowM3S: 1 }],
          boundaries: [{ domain: "surface", cell: 0, edge: 0, kind: 2, value: -1 }],
        }),
      ).toThrow(pkg.BadParamError);
      expect(() => b.surface.sourceReceipt("bad")).toThrow(pkg.BadIndexError);
      expect(() => solver.surface2d.setFlowBoundary(0, 0, -1)).toThrow(pkg.BadParamError);
      expect(() => solver.surface2d.forceRainfallUniform(0.01)).toThrow(pkg.BadParamError);
      expect(() => b.surface.setForcings([{ channel: "rainfall", cell: 0, rateMS: 0.1 }])).toThrow(
        pkg.BadParamError,
      );
      expect(solver.elapsed).toBe(0);
      solver.advanceTo(5);
      const first = a.surface.sourceReceipts([0, 1], "x").map((r) => r.appliedM3);
      expect(first[0]).toBeCloseTo(0.05, 12);
      expect(first[1]).toBeCloseTo(0.1, 12);
      expect(b.surface.sourceReceipt("x").appliedM3).toBeCloseTo(0.015, 12);
      expect(a.groundwater.sourceReceipt("x").appliedM3).toBeCloseTo(0.005, 12);
      a.surface.clearSource("x", 0);
      a.surface.clearBoundary(0, 0);
      b.surface.setBoundary(0, 0, 2, -0.001);
      solver.advanceTo(10);
      const second = a.surface.sourceReceipts([0, 1], "x").map((r) => r.appliedM3);
      expect(second[0]).toBeCloseTo(0.05, 12);
      expect(second[1]).toBeCloseTo(0.2, 12);
      expect(() => a.groundwater.setForcings([])).toThrow(RangeError);
      expect(() =>
        a.surface.setBoundaries([{ domain: "groundwater", cell: 0, edge: 0, kind: 0 }]),
      ).toThrow(/domain mismatch/);
      evidence.providers = {
        first,
        second,
        b: b.surface.sourceReceipt("x"),
        groundwater: a.groundwater.sourceReceipt("x"),
        capabilities: solver.coupling.capabilities,
      };
    } finally {
      solver.destroy();
    }
  });

  it("expires rainfall quality and receipts paired infiltration", async () => {
    const { pkg, solver } = await runtime({ groundwater: true, heat: true });
    try {
      const p = solver.coupling.forProvider("rain");
      const sw = solver.surface2d;
      const gw = solver.groundwater2d;
      const total = () => sw.totalVolume + gw.ledger(pkg.GroundwaterLedger.STORAGE);
      const initial = total();
      p.surface.setForcings([
        {
          channel: "rainfall",
          rateMS: 0.0001,
          concentrations: { TSS: 7, __TEMPERATURE__: 10 },
          untilSeconds: 10,
        },
      ]);
      solver.advanceTo(10);
      const rain = (sw.getTriangleArea(0) + sw.getTriangleArea(1)) * 0.0001 * 10;
      expect(total() - initial).toBeCloseTo(rain, 10);
      expect(sw.speciesLedger("TSS").rainfallIn).toBeCloseTo(7 * rain, 10);
      p.surface.setForcings([
        { channel: "infiltration", cell: 0, rateMS: 0.00001, untilSeconds: 15 },
      ]);
      solver.advanceTo(15);
      const receipt = p.surface.infiltrationReceipt(0);
      expect(receipt.appliedM3).toBeGreaterThan(0);
      expect(receipt.appliedSpecies.TSS).toBeCloseTo(receipt.appliedM3 * 7, 10);
      expect(receipt.appliedHeatJ).toBeCloseTo(receipt.appliedSpecies.__TEMPERATURE__ * 4186000, 4);
      solver.advanceTo(20);
      expect(p.surface.infiltrationReceipt(0).appliedM3).toBeCloseTo(receipt.appliedM3, 15);
      expect(Math.abs(gw.continuityError)).toBeLessThan(1e-8);
      expect(() => p.groundwater.infiltrationReceipt(0)).toThrow(RangeError);
      evidence.rainfall = { rain, receipt, ledger: sw.speciesLedger("TSS") };
    } finally {
      solver.destroy();
    }
  });

  it("reports full-SWE runtime capabilities as unsupported", async () => {
    const { pkg, solver } = await runtime({ momentum: "FULL_SWE" });
    try {
      const caps = solver.coupling.capabilities;
      expect(caps.surfaceSources).toBe(false);
      expect(caps.atomicFrames).toBe(false);
      expect(() => solver.surface2d.setWaterSource(0, 0.01)).toThrow(pkg.PluginError);
      expect(solver.elapsed).toBe(0);
      evidence.fullSweCapabilities = caps;
    } finally {
      solver.destroy();
    }
  });
});
