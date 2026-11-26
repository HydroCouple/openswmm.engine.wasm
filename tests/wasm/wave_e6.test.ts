/**
 * Real module, wave E part 6: groundwater beds, boundaries, options and
 * species readers, and groundwater transport tables, on the mixed-cell model
 * of python/tests/engine/_groundwater_cases.py (the transport and species
 * cases follow python/tests/engine/test_new_domain_tables.py).
 *
 * Results go to tests/_work/wasm/e6/wave_e6.json for
 * tests/_work/wasm/e6/crosscheck.py (run by hand with native Python).
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { built, load, title, work } from "./load.js";
import { MIXED_CELL_MODEL } from "./decks.js";

async function opened(text = MIXED_CELL_MODEL) {
  const { mod, pkg } = await load();
  const solver = new pkg.Solver(mod);
  solver.writeFile("/mixed.inp", text);
  solver.open("/mixed.inp", "/mixed.rpt", "/mixed.out");
  return { mod, pkg, solver };
}

describe.skipIf(!built)(title("real module: wave E part 6 (groundwater)"), () => {
  const evidence: Record<string, unknown> = {};
  afterAll(() => {
    const out = resolve(work, "e6");
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "wave_e6.json"), JSON.stringify(evidence, null, 1) + "\n");
  });

  it("authors options, node and link beds and boundaries", async () => {
    const { pkg, solver } = await opened();
    const { CellScope } = pkg;
    try {
      const gw = solver.groundwater2d;
      expect(gw).toBe(solver.surface2d.groundwater);
      evidence.options = Object.fromEntries([...gw.options].map((k) => [k, gw.options.get(k)]));
      expect(gw.options.length).toBe(18);
      expect(() => gw.options.delete("MODE")).toThrow(TypeError);
      gw.addRow({ scope: CellScope.GLOBAL, ks: 36, zs: 0.5, thetaS: 0.45, thetaR: 0.1, alpha: 2 });
      expect(() => gw.options.setProcessOptions({ et: "OFF", link: "OFF" })).toThrow(
        pkg.BadParamError,
      );
      gw.options.setProcessOptions({ et: "AUTO", link: "AUTO" });
      evidence.processOptions = [gw.options.get("GW_ET"), gw.options.get("LINK_SEEPAGE")];

      gw.addNode("J1", 0, 0.5, 1);
      gw.addLink("C1", 0, 0, true);
      const nodes = gw.nodes;
      evidence.nodes = nodes;
      evidence.links = gw.links;
      gw.setNodeExchange(0, false);
      expect(gw.nodes[0].exchange).toBe(false);
      const edited = [{ ...gw.nodes[0], kc: 0.75 }];
      gw.replaceNodes(gw.nodes, edited, { apply: false });
      expect(gw.nodes[0].kc).toBe(0.5); // validation only
      expect(() => gw.replaceNodes(nodes, edited)).toThrow(pkg.EngineError); // stale expectation
      gw.replaceNodes(gw.nodes, edited);
      expect(gw.nodes[0].kc).toBe(0.75);
      gw.removeNode(0);
      gw.removeLink(0);
      expect([gw.nodes, gw.links]).toEqual([[], []]);

      gw.setAuthoredBoundary(1, 1, "head", 0.5);
      gw.setAuthoredBoundary(1, 2, "FLOW", 0.001);
      evidence.authoredBoundaries = gw.authoredBoundaries;
      expect(() => gw.setAuthoredBoundary(1, 1, "WALL")).toThrow(RangeError);
      gw.removeAuthoredBoundary(1);
      expect(gw.authoredBoundaries).toHaveLength(1);
    } finally {
      solver.destroy();
    }
  });

  it("round-trips the groundwater transport tables through a saved model", async () => {
    const { pkg, solver } = await opened();
    const { CellScope } = pkg;
    try {
      const t = solver.surface2d.groundwater.transport;
      t.options.set("TRANSPORT_POLLUTANTS", "YES");
      expect(t.options.get("TRANSPORT_POLLUTANTS")).toBe("YES");
      expect([...t.options]).toHaveLength(19);
      expect(t.authored).toBe(true);
      t.setParameters();
      t.setParameters({ ...t.parameters[0], rhoS: 2700 });
      expect(t.parameters).toHaveLength(1);
      expect(t.parameters[0].rhoS).toBe(2700);
      t.setSorption({ species: "TSS", kd: 0.25 });
      t.setInitialQuality({ species: "TSS", value: 5 });
      t.setBoundary({ cell: 1, edge: 3, species: "TSS", value: 2 });
      t.setSource({ name: "well", scope: CellScope.CELL, cell: 1, flow: 1e-5 });
      t.setSource({
        name: "xy",
        scope: CellScope.CELL,
        cell: 0,
        flow: 2e-5,
        byXy: true,
        x: 5,
        y: 5,
      });
      expect(() =>
        t.setSource({
          name: "bad",
          scope: CellScope.GLOBAL,
          cell: 0,
          flow: 0,
          byXy: true,
          x: 1,
          y: 1,
        }),
      ).toThrow(pkg.BadParamError);
      const tables = {
        parameters: t.parameters,
        sorption: t.sorption,
        initialQuality: t.initialQuality,
        boundaries: t.boundaries,
        sources: t.sources,
      };
      evidence.transportTables = tables;
      solver.writeModel("/transport.inp");

      const other = new pkg.Solver(solver.module);
      try {
        other.open("/transport.inp", "/transport.rpt", "/transport.out");
        const back = other.surface2d.groundwater.transport;
        expect({
          parameters: back.parameters,
          sorption: back.sorption,
          initialQuality: back.initialQuality,
          boundaries: back.boundaries,
          sources: back.sources,
        }).toEqual(tables);
      } finally {
        other.destroy();
      }

      t.initialQualityFile = "quality.csv";
      expect(t.initialQualityFile).toBe("quality.csv");
      t.initialQualityFile = null;
      expect(t.initialQualityFile).toBe("");
      t.removeParameters(0);
      t.removeSorption(0);
      t.removeInitialQuality(0);
      t.removeBoundary(0);
      expect([t.parameters, t.sorption, t.initialQuality, t.boundaries]).toEqual([[], [], [], []]);
    } finally {
      solver.destroy();
    }
  });

  it("reads species, concentrations, ledgers and execution status while running", async () => {
    const { pkg, solver } = await opened();
    const { CellScope, GroundwaterZone, GroundwaterSpeciesLedger } = pkg;
    try {
      const gw = solver.groundwater2d;
      gw.options.set("NODE_ENROLMENT", "ROWS");
      gw.addRow({ scope: CellScope.GLOBAL, ks: 36, zs: 0.5, thetaS: 0.45, thetaR: 0.1, alpha: 2 });
      gw.setRowProperty(0, "HG0", 0.2);
      gw.transport.options.set("TRANSPORT_POLLUTANTS", "YES");
      gw.transport.setInitialQuality({ species: "TSS", value: 5 });
      solver.initialize();
      solver.start(false);
      solver.step();
      const index = gw.species.indexOf("TSS");
      evidence.species = gw.species;
      const zones: Record<string, number[]> = {};
      for (const zone of [GroundwaterZone.SAT, GroundwaterZone.UNSAT]) {
        const values = gw.concentrations(zone, index);
        expect(values).toHaveLength(2);
        expect(Array.from(values).every(Number.isFinite)).toBe(true);
        zones[GroundwaterZone[zone]] = Array.from(values);
      }
      evidence.concentrations = zones;
      const ledger = Object.values(GroundwaterSpeciesLedger)
        .filter((v): v is number => typeof v === "number")
        .map((term) => gw.speciesLedger(index, term));
      expect(ledger.every(Number.isFinite)).toBe(true);
      evidence.speciesLedger = ledger;
      const status = gw.executionStatus;
      expect(status.active).toBe(true);
      evidence.executionStatus = { ...status, effectiveThreads: undefined };
      solver.end();
    } finally {
      solver.destroy();
    }
  });
});
