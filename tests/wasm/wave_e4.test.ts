/**
 * Real module, wave E part 4: heat transport configuration, overrides,
 * snapshots and atomic edits on the deck of python/tests/engine/test_heat.py,
 * then a short run for the current-state readers.
 *
 * Results go to tests/_work/wasm/e4/wave_e4.json for
 * tests/_work/wasm/e4/crosscheck.py (run by hand with native Python).
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { built, load, title, work } from "./load.js";
import { HEAT_CONFIG, heatInp } from "./decks.js";

async function opened() {
  const { mod, pkg } = await load();
  const solver = new pkg.Solver(mod);
  solver.writeFile("/heat.heat", HEAT_CONFIG);
  solver.writeFile("/heat.inp", heatInp("heat.heat"));
  solver.open("/heat.inp", "/heat.rpt", "/heat.out");
  return { mod, pkg, solver };
}

describe.skipIf(!built)(title("real module: wave E part 4 (heat)"), () => {
  const evidence: Record<string, unknown> = {};
  afterAll(() => {
    const out = resolve(work, "e4");
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "wave_e4.json"), JSON.stringify(evidence, null, 1) + "\n");
  });

  it("reads and edits the heat tables", async () => {
    const { pkg, solver } = await opened();
    const { HeatFluxModule, HeatShortwaveMode, HeatSourceKind, HeatAttr, HeatOverrideScope } = pkg;
    try {
      const heat = solver.heat;
      expect(heat.enabled).toBe(true);
      expect(heat.modules.get(HeatFluxModule.RADIATIVE_EXCHANGE)).toBe(true);
      evidence.modules = [...heat.modules].map((m) => heat.modules.get(m));
      evidence.radiative = [...heat.radiative].map((p) => heat.radiative.get(p));
      evidence.sources = [...heat.sources].map((s) => [
        heat.sources.get(s),
        heat.sources.isConfigured(s),
      ]);
      evidence.nodeOverrides = [...heat.nodeOverrides];
      evidence.shortwaveMode = heat.shortwaveMode;
      evidence.cloud = { configured: heat.cloud.configured, fraction: heat.cloud.get("FRACTION") };
      evidence.authoringFlags = heat.authoringFlags;
      evidence.lidMaterial = heat.lidMaterial;
      evidence.dryPolicy = heat.dryPolicy;

      expect(heat.sources.get("dwf")).toBe(15);
      expect(heat.sources.effective(HeatSourceKind.DWF, "J1")).toBe(22);
      expect(heat.sources.effective("DWF", "J2")).toBe(15);
      expect(heat.solarSited).toBe(false);
      expect(() => (heat.shortwaveMode = HeatShortwaveMode.COMPUTED)).toThrow(pkg.EngineError);
      heat.solar.set("LATITUDE", 41.74);
      heat.solar.set("longitude", -111.83);
      expect(heat.solarSited).toBe(true);
      heat.shortwaveMode = "COMPUTED";
      heat.setShortwaveTimeseries("sw_ts");
      expect([heat.shortwaveMode, heat.shortwaveTimeseries]).toEqual([
        HeatShortwaveMode.TIMESERIES,
        "sw_ts",
      ]);
      heat.cloud.setTimeseries("cloud_ts");
      expect(heat.cloud.timeseries).toBe("cloud_ts");
      expect(() => heat.radiative.set("ALBEDO", 2)).toThrow(pkg.EngineError);
      heat.radiative.set("albedo", 0.08);
      expect(heat.radiative.get(pkg.HeatRadiativeParam.ALBEDO)).toBe(0.08);
      expect(() => heat.modules.get("nope")).toThrow(pkg.ElementNotFoundError);

      heat.nodeOverrides.set("EXTERNAL_INFLOW", "J2", 18);
      expect(heat.nodeOverrides.length).toBe(2);
      heat.nodeOverrides.remove(-1 + heat.nodeOverrides.length);
      heat.sources.set(HeatSourceKind.RAINFALL, 12);
      expect(heat.sources.isConfigured("RAINFALL")).toBe(true);
      heat.sources.clear("RAINFALL");
      expect(heat.sources.isConfigured("RAINFALL")).toBe(false);

      heat.elementOverrides.set(HeatAttr.ALBEDO, HeatOverrideScope.LINK, "C1", 0.2);
      expect(heat.effectiveElement("ALBEDO", "LINK", "C1")).toEqual({
        value: 0.2,
        source: 3,
        sourceName: "C1",
      });
      heat.sediment.groundTimeseries = "air_ts";
      const dynamic = heat.effectiveElement("GROUND_TEMPERATURE", "LINK", "C1");
      expect(Number.isNaN(dynamic.value)).toBe(true);
      expect([dynamic.source, dynamic.sourceName]).toEqual([5, "air_ts"]);
      expect(() => heat.effectiveElement("ALBEDO", "LINK", "C1\0x")).toThrow(RangeError);
      evidence.elementOverrides = [...heat.elementOverrides];
      evidence.sediment = [...heat.sediment].map((p) => heat.sediment.get(p));
      evidence.meshStatus = heat.meshStatus;
      evidence.groundStatus = heat.groundStatus();
      evidence.channelGroundStatus = heat.channelGroundStatus();
      expect(() => heat.meshValues(0, 0, -1)).toThrow(RangeError);
    } finally {
      solver.destroy();
    }
  });

  it("restores snapshots and rolls atomic edits back", async () => {
    const { pkg, solver } = await opened();
    try {
      const heat = solver.heat;
      const before = [heat.dryPolicy, heat.authoringFlags, heat.radiative.get("ALBEDO")];
      {
        using saved = heat.snapshot();
        for (const albedo of [0.1, 0.2]) {
          heat.radiative.set("ALBEDO", albedo);
          heat.dryPolicy = 2;
          heat.solar.set("LATITUDE", 40);
          saved.restore();
          expect([heat.dryPolicy, heat.authoringFlags, heat.radiative.get("ALBEDO")]).toEqual(
            before,
          );
        }
        saved.close();
        expect(() => saved.restore()).toThrow(RangeError);
      }
      const stale = heat.snapshot({ complete: true });
      heat.elementOverrides.set("ALBEDO", "LINK", "C1", 0.1);
      expect(() => stale.restore()).toThrow(pkg.StaleObjectError);
      stale.close();

      expect(
        heat.editAtomic((owner) => {
          owner.heat.radiative.set("ALBEDO", 0.12);
          owner.climate.evapMonthly = new Array(12).fill(0.25);
          return "committed";
        }),
      ).toBe("committed");
      const old = [
        heat.authoringFlags,
        heat.radiative.get("ALBEDO"),
        Array.from(solver.climate.evapMonthly),
      ];
      const failure = new Error("abort hydrothermal edit");
      expect(() =>
        heat.editAtomic((owner) => {
          owner.heat.radiative.set("ALBEDO", 0.4);
          owner.climate.evapMonthly = new Array(12).fill(0.5);
          owner.heat.solar.set("LATITUDE", 20);
          throw failure;
        }),
      ).toThrow(failure);
      expect([
        heat.authoringFlags,
        heat.radiative.get("ALBEDO"),
        Array.from(solver.climate.evapMonthly),
      ]).toEqual(old);
      const albedo = heat.radiative.get("ALBEDO");
      expect(() =>
        heat.editAtomic((owner) => {
          owner.heat.radiative.set("ALBEDO", 0.3);
          owner.heat.editAtomic(() => undefined);
        }),
      ).toThrow(pkg.LifecycleError);
      expect(heat.radiative.get("ALBEDO")).toBe(albedo);
      for (const method of ["close", "destroy", "initialize"] as const) {
        expect(() => heat.editAtomic((owner) => owner[method]())).toThrow(pkg.LifecycleError);
      }
      expect(() => heat.editAtomic(null as unknown as () => void)).toThrow(TypeError);
      solver.initialize();
      expect(() => heat.editAtomic(() => undefined)).toThrow(pkg.LifecycleError);
      expect(() => heat.snapshot()).toThrow(pkg.LifecycleError);
    } finally {
      solver.destroy();
    }
  });

  it("refuses lifecycle calls from inside a callback, as Python does", async () => {
    const { pkg, solver } = await opened();
    try {
      solver.initialize();
      solver.start(false);
      solver.setStepEndCallback(() => solver.destroy());
      expect(() => solver.step()).toThrow(pkg.LifecycleError);
      expect(solver.elapsed).toBeGreaterThan(0); // the engine survived
      solver.setStepEndCallback(() => solver.step());
      expect(() => solver.step()).toThrow(pkg.LifecycleError);
      solver.setStepEndCallback(null);
      expect(solver.step()).toBeGreaterThan(0);
      solver.end();
    } finally {
      solver.destroy();
    }
  });

  it("reads current shortwave and cloud while running", async () => {
    const { solver } = await opened();
    try {
      const heat = solver.heat;
      solver.initialize();
      solver.start(false);
      solver.until(300);
      evidence.running = {
        shortwave: heat.currentShortwave,
        cloud: heat.cloud.current,
        meshStatus: heat.meshStatus,
      };
      expect(heat.cloud.current).toBeCloseTo(0.25, 12);
      solver.end();
    } finally {
      solver.destroy();
    }
  });
});
