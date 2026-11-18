/**
 * Real module, wave B: node members, the storage/outfall/divider sub-views and
 * the Nodes collection on tests/fixtures/smoke.inp (junctions J1.., outfall O1).
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

describe.skipIf(!built)(title("real module: nodes (wave B)"), () => {
  it("reads and writes node properties", async () => {
    const { pkg, solver } = await opened();
    try {
      const j = solver.nodes.get(0);
      expect(j.solver).toBe(solver);
      j.tag = "manhole";
      expect(j.tag).toBe("manhole");
      j.surchargeDepth = 2;
      expect(j.surchargeDepth).toBe(2);
      j.pondedArea = 10;
      expect(j.pondedArea).toBe(10);
      j.initialDepth = 0.25;
      expect(j.initialDepth).toBe(0.25);
      expect(j.degree).toBeGreaterThan(0);
      expect(typeof j.isVirtual).toBe("boolean");
      expect(Number.isInteger(j.virtualRuleViolation)).toBe(true);
      expect(Number.isInteger(j.inletRuleViolation(true))).toBe(true);
      expect(j.rimDepth).toBeGreaterThanOrEqual(0);
      expect(() => j.quality("no-such-pollutant")).toThrow(pkg.ElementNotFoundError);
      expect(() => j.outfall).toThrow(TypeError);
    } finally {
      solver.destroy();
    }
  });

  it("edits outfall, storage and divider sub-views", async () => {
    const { pkg, solver } = await opened();
    try {
      const outfall = solver.nodes.get("O1").outfall;
      outfall.flapGate = true;
      expect(outfall.flapGate).toBe(true);
      outfall.setStage(1.5);
      expect(outfall.type).toBe(pkg.OutfallType.FIXED);
      expect(outfall.param).toBe(1.5);
      expect(outfall.routeTo).toBe(-1);

      const st = solver.nodes.add("ST1", pkg.NodeType.STORAGE).storage;
      st.shape = pkg.StorageShape.FUNCTIONAL;
      st.functional = [100, 0.5, 20];
      expect(st.shape).toBe(pkg.StorageShape.FUNCTIONAL);
      expect(st.functional).toEqual([100, 0.5, 20]);
      st.seepRate = 0.1;
      expect(st.seepRate).toBe(0.1);
      st.exfilParams = [4, 0.5, 0.25];
      expect(st.exfilParams).toEqual([4, 0.5, 0.25]);
      expect(st.seepRate).toBe(0); // Green-Ampt replaces the constant rate

      const dv = solver.nodes.add("DV1", pkg.NodeType.DIVIDER).divider;
      const params = dv.params;
      expect(Object.keys(params)).toEqual([
        "method",
        "diversion_link",
        "curve",
        "cutoff_flow",
        "weir_height",
        "weir_coefficient",
      ]);
      dv.params = { ...params, cutoff_flow: 3 };
      expect(dv.params.cutoff_flow).toBe(3);
    } finally {
      solver.destroy();
    }
  });

  it("collection: ids, rename, add/popLast and bulk flows", async () => {
    const { pkg, solver } = await opened();
    try {
      const { nodes } = solver;
      const ids = nodes.ids;
      expect(ids.length).toBe(nodes.length);
      expect(nodes.has(ids[0])).toBe(true);
      expect(nodes.has(99)).toBe(false);
      nodes.rename(ids[0], "J1b");
      expect(nodes.ids[0]).toBe("J1b");
      nodes.add("TMP", pkg.NodeType.JUNCTION);
      nodes.popLast("TMP");
      expect(nodes.length).toBe(ids.length);

      solver.initialize();
      solver.start(true);
      nodes.setLateralInflows(new Array(nodes.length).fill(0.5));
      solver.until(1800);
      expect(nodes.inflows.length).toBe(nodes.length);
      expect(Math.max(...nodes.inflows)).toBeGreaterThan(0);
      expect(nodes.outflows.length).toBe(nodes.length);
      expect(nodes.losses.length).toBe(nodes.length);
      expect(() => nodes.setLateralInflows([1])).toThrow(RangeError);
      solver.end();
      const receipt = nodes.get("O1").outfall.exportReceipt;
      expect(receipt.exported_m3).toBeGreaterThan(0);
      expect(receipt.pollutant_amounts).toEqual({});
    } finally {
      solver.destroy();
    }
  });
});
