/**
 * Real module, wave E part 5: the rest of `surface2d` (initial and boundary
 * quality, initial HGL, edges, wall drag, node coupling, species,
 * concentrations, surface owners, results file) and the infiltration
 * defaults mapping, authored rows and ownership, on the mixed-cell model of
 * python/tests/engine/_groundwater_cases.py.
 *
 * Results go to tests/_work/wasm/e5/wave_e5.json for
 * tests/_work/wasm/e5/crosscheck.py (run by hand with native Python).
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { built, load, title, work } from "./load.js";
import { MIXED_CELL_MODEL } from "./decks.js";

async function opened() {
  const { mod, pkg } = await load();
  const solver = new pkg.Solver(mod);
  solver.writeFile("/mixed.inp", MIXED_CELL_MODEL);
  solver.open("/mixed.inp", "/mixed.rpt", "/mixed.out");
  return { mod, pkg, solver };
}

describe.skipIf(!built)(title("real module: wave E part 5 (2D remainder)"), () => {
  const evidence: Record<string, unknown> = {};
  afterAll(() => {
    const out = resolve(work, "e5");
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "wave_e5.json"), JSON.stringify(evidence, null, 1) + "\n");
  });

  it("authors quality rows, edges, coupling and initial HGL", async () => {
    const { pkg, solver } = await opened();
    try {
      const s = solver.surface2d;
      evidence.scale = s.geometryScaleToSi;
      s.setTriangleInitHgl(0, 0.5);
      expect(s.getTriangleInitHgl(0)).toBe(0.5);
      s.setTriangleInitHgl(0, NaN);
      expect(Number.isNaN(s.getTriangleInitHgl(0))).toBe(true);

      s.setInitialQuality("TSS", 5);
      s.setInitialQuality("TSS", 7, { tag: "PAN" });
      s.setInitialQuality("TSS", 9, { cell: 0 });
      s.setInitialQuality("TSS", 6); // replaces the * row
      evidence.initialQuality = s.initialQuality;
      s.removeInitialQuality(1);
      expect(s.initialQuality).toHaveLength(2);
      s.setInitialBedQuality("TSS", 2, { tag: "FAR" });
      evidence.initialBedQuality = s.initialBedQuality;
      s.removeInitialBedQuality(0);
      expect(s.initialBedQuality).toEqual([]);

      s.prepareForEdit();
      const stride = s.edgeStride;
      const exterior = [0, 1].map((cell) =>
        Array.from({ length: stride }, (_, e) => {
          try {
            return s.edgeIsExterior(cell, e);
          } catch {
            return null;
          }
        }),
      );
      evidence.exterior = exterior;
      const edge = exterior[1].indexOf(true);
      s.setEdgeWallDrag(1, edge, 0.1);
      expect(s.getEdgeWallDrag(1, edge)).toBe(0.1);
      expect(() => s.setEdgeWallDrag(1, edge, -1)).toThrow(pkg.EngineError);
      s.setEdgeBcGroup(1, edge, "G1");
      expect(() => s.setEdgeBcGroup(1, edge, "a\0b")).toThrow(RangeError);
      try {
        s.setBoundaryQuality(1, edge, "TSS", 3);
        evidence.boundaryQuality = s.boundaryQuality;
        s.removeBoundaryQuality(0);
      } catch (err) {
        evidence.boundaryQuality = `refused: ${(err as Error).name}`;
      }

      const [type, authored] = s.getNodeCouplingType(0);
      evidence.coupling = { type, authored, default: s.getNodeCouplingDefaultType(0) };
      s.validateNodeCoupling(0, type, { D: 0.5 });
      s.replaceNodeCoupling(0, type, { D: 0.5 });
      expect(s.getNodeCouplingType(0)).toEqual([type, true]);
      evidence.couplingD = s.getNodeCouplingParam(0, "D");
      s.setNodeCouplingParam(0, "D", null);
      evidence.couplingDCleared = s.getNodeCouplingParam(0, "D");
      expect(() => s.validateNodeCoupling(0, type, { NOT_A_KEY: 1 })).toThrow(pkg.EngineError);
      s.resetNodeCoupling(0);
      expect(s.getNodeCouplingType(0)[1]).toBe(false);
      s.setAutoBackendCpu(true);
    } finally {
      solver.destroy();
    }
  });

  it("edits infiltration defaults, authored rows and reads ownership", async () => {
    const { pkg, solver } = await opened();
    const { SurfaceInfilMethod: M, SurfaceInfilDest: D } = pkg;
    try {
      const infil = solver.surface2d.infiltration;
      const defaults = infil.defaults;
      expect(defaults.length).toBe(0);
      defaults.set("*", { method: M.HORTON, params: [3, 0.5, 4.14, 7, 0], dest: D.LOST });
      defaults.set("PAN", { method: null, params: [], dest: D.LOST });
      expect([...defaults]).toEqual(["*", "PAN"]);
      expect(defaults.get("*").method).toBe(M.HORTON);
      expect(defaults.has("FAR")).toBe(false);
      expect(() => defaults.get("FAR")).toThrow(pkg.ElementNotFoundError);
      defaults.delete("PAN");
      expect(defaults.length).toBe(1);
      infil.setCell(1, { method: M.HORTON, params: [2, 0.4, 4, 7, 0], dest: D.LOST });
      const rows = infil.authoredRows();
      evidence.authoredRows = rows;
      infil.replaceAuthoredRows(rows);
      expect(infil.authoredRows()).toEqual(rows);
      evidence.ownership = [infil.ownership(0), infil.ownership(1)];
      const [owners, aquifers, conflicts] = infil.ownershipBulk();
      expect([Array.from(owners), Array.from(aquifers), Array.from(conflicts)]).toEqual([
        [infil.ownership(0)[0], infil.ownership(1)[0]],
        [infil.ownership(0)[1], infil.ownership(1)[1]],
        [infil.ownership(0)[2], infil.ownership(1)[2]],
      ]);
    } finally {
      solver.destroy();
    }
  });

  it("previews surface owners, binds a results file and reads species while running", async () => {
    const { mod, pkg, solver } = await opened();
    try {
      const s = solver.surface2d;
      expect(Array.from(s.getSurfaceOwners())).toEqual([]);
      const preview = s.previewSurfaceOwners();
      evidence.ownerPreview = { ...preview, meshWeatherArea: Array.from(preview.meshWeatherArea) };
      s.replaceSurfaceOwners([], preview.token);
      expect(() => s.replaceSurfaceOwners([], "0000000000000000")).toThrow(pkg.EngineError);
      expect(() => s.previewSurfaceOwners([-1])).toThrow(RangeError);
      s.setResultsFile("/bound_results.h5");
      expect(() => s.setResultsFile("relative.h5")).toThrow(pkg.EngineError);
      s.setInitialQuality("TSS", 4);
      solver.initialize();
      solver.start(false);
      solver.until(120);
      const species = s.species;
      evidence.species = species;
      const conc = s.concentrations(species.indexOf("TSS"));
      expect(conc).toHaveLength(2);
      evidence.concentrations = Array.from(conc);
      evidence.reportRainfall = Array.from(s.getReportRainfallBulk(solver.simStartTime));
      solver.end();
      expect(mod.FS.analyzePath("/bound_results.h5").exists).toBe(true);
    } finally {
      solver.destroy();
    }
  });
});
