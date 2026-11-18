/**
 * Real module, wave B: link members, the xsect/pump/weir/orifice/outlet/stats
 * sub-views and the Links collection on tests/fixtures/smoke.inp (conduits
 * C1..C3, circular 1.5/2/2 ft).
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

describe.skipIf(!built)(title("real module: links (wave B)"), () => {
  it("reads and writes conduit properties, nodes and cross-section", async () => {
    const { pkg, solver } = await opened();
    try {
      const c1 = solver.links.get("C1");
      expect(c1.solver).toBe(solver);
      expect(c1.fromNode.index).toBe(c1.fromNodeIndex);
      expect(c1.toNode.id).toBe(solver.nodes.getId(c1.toNodeIndex));
      c1.length = 420;
      expect(c1.length).toBe(420);
      c1.roughness = 0.015;
      expect(c1.roughness).toBe(0.015);
      c1.offsetUp = 0.5;
      expect(c1.offsetUp).toBe(0.5);
      c1.lossCoeff = [0.5, 1, 0.1];
      expect(c1.lossCoeff).toEqual([0.5, 1, 0.1]);
      c1.flapGate = true;
      expect(c1.flapGate).toBe(true);
      c1.barrels = 2;
      expect(c1.barrels).toBe(2);
      c1.tag = "trunk";
      expect(c1.tag).toBe("trunk");
      expect(typeof c1.isClosed).toBe("boolean"); // Python's `closed`; settable while running

      const x = c1.xsect;
      expect(x.shape).toBe(pkg.XSectShape.CIRCULAR);
      expect(x.g1).toBe(1.5);
      expect([...x]).toEqual(x.asTuple());
      expect(x.info().geomLabels).toEqual({ diameter: 1.5 });
      const geom = x.geometry();
      expect(geom.fullDepth).toBe(1.5);
      geom.destroy();
      c1.xsect = [pkg.XSectShape.RECT_CLOSED, 2, 3, 0, 0];
      expect(solver.links.getXsectInfo("C1").geomLabels).toEqual({ height: 2, width: 3 });

      const [from, to] = [c1.toNode.id, c1.fromNode.id];
      c1.setNodes(from, to);
      expect(c1.fromNode.id).toBe(from);
      expect(() => c1.pump).toThrow(TypeError);
    } finally {
      solver.destroy();
    }
  });

  it("adds pumps, weirs, orifices and outlets and edits their sub-views", async () => {
    const { pkg, solver } = await opened();
    try {
      const { links } = solver;
      const [a, b] = [solver.nodes.getId(0), solver.nodes.getId(1)];
      const pump = links.add("P1", pkg.LinkType.PUMP);
      pump.setNodes(a, b);
      const pv = links.get("P1").pump;
      pv.startupDepth = 2;
      pv.shutoffDepth = 0.5;
      pv.initState = true;
      expect([pv.startupDepth, pv.shutoffDepth, pv.initState]).toEqual([2, 0.5, true]);

      const weir = links.add("W1", pkg.LinkType.WEIR).weir;
      weir.crestHeight = 1.2;
      weir.dischargeCoeff = 3.3;
      weir.type = pkg.WeirType.SIDEFLOW;
      expect([weir.crestHeight, weir.dischargeCoeff, weir.type]).toEqual([
        1.2,
        3.3,
        pkg.WeirType.SIDEFLOW,
      ]);

      const orifice = links.add("OR1", pkg.LinkType.ORIFICE).orifice;
      orifice.openCloseRate = 0.25;
      expect(orifice.openCloseRate).toBe(0.25);

      const outlet = links.add("OL1", pkg.LinkType.OUTLET).outlet;
      outlet.expon = 0.5;
      expect(outlet.expon).toBe(0.5);
      expect(links.ids.slice(-4)).toEqual(["P1", "W1", "OR1", "OL1"]);
      links.popLast("OL1");
      links.rename("OR1", "OR2");
      expect(links.has("OR2")).toBe(true);
    } finally {
      solver.destroy();
    }
  });

  it("collects statistics and bulk arrays from a run", async () => {
    const { solver } = await opened();
    try {
      const { links } = solver;
      solver.initialize();
      solver.start(true);
      solver.until(3600);
      expect(links.volumes.length).toBe(links.length);
      expect(links.controlSettings.length).toBe(links.length);
      expect(links.targetSettings.length).toBe(links.length);
      expect(links.hydPowers.length).toBe(links.length);
      const [cycles, onTime, volume] = links.pumpStats();
      expect([cycles.length, onTime.length, volume.length]).toEqual([3, 3, 3]);
      while (solver.step() > 0);
      solver.end();
      const stats = links.get("C3").stats;
      expect(stats.maxFlow).toBeGreaterThan(0);
      expect(stats.volFlow).toBeGreaterThan(0);
      expect(stats.maxFilling).toBeGreaterThan(0);
      expect(stats.pumpCycles).toBe(0); // the engine reads pump columns for any link
    } finally {
      solver.destroy();
    }
  });
});
