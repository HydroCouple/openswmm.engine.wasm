/**
 * Real module, wave D part 2: solver.spatial and the ModelEditor on
 * tests/fixtures/smoke.inp (and a ModelBuilder owner).
 *
 * The values read here are written to tests/_work/wasm/d2/wave_d2.json; the
 * same edits through native Python (tests/_work/wasm/d2/crosscheck.py, run by
 * hand) must give the same results.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { built, fixtures, load, title, work } from "./load.js";

const plain = (
  entries: { objTypeName: string; objIdx: number; field: string; cascaded: boolean }[],
) => entries.map((e) => [e.objTypeName, e.objIdx, e.field, e.cascaded]);

async function opened() {
  const { mod, pkg } = await load();
  const solver = new pkg.Solver(mod);
  solver.writeFile("/smoke.inp", readFileSync(resolve(fixtures, "smoke.inp"), "utf8"));
  solver.open("/smoke.inp", "/smoke.rpt", "/smoke.out");
  return { mod, pkg, solver };
}

describe.skipIf(!built)(title("real module: wave D part 2 (spatial, editor)"), () => {
  const evidence: Record<string, unknown> = {};

  it("edits coordinates, polygons, [MAP], annotations and the CRS", async () => {
    const { pkg, solver } = await opened();
    try {
      const sp = solver.spatial;
      expect(sp.crs).toBe(""); // as native Python; solver.crs throws CRSError instead
      sp.crs = "EPSG:32618";
      expect(sp.crs).toBe("EPSG:32618");
      expect(sp.nodeHasCoord("J1")).toBe(true);
      expect(sp.nodeCoord("J2")).toEqual([400, 0]);
      sp.setNodeCoord("J2", 410, 5);
      const coords = sp.nodeCoords();
      expect(coords.shape).toEqual([4, 2]);
      expect(Array.from(coords.data.subarray(2, 4))).toEqual([410, 5]);
      sp.setNodeCoords([
        [0, 1],
        [2, 3],
        [4, 5],
        [6, 7],
      ]);
      expect(Array.from(sp.nodeCoords().data)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(() => sp.setNodeCoords([[0, 0]])).toThrow(RangeError);
      sp.setLinkVertices("C1", [
        [100, 10],
        [200, 20],
      ]);
      // The read polyline runs from the start node to the end node (as native Python).
      expect(Array.from(sp.linkVertices("C1").data)).toEqual([0, 1, 100, 10, 200, 20, 2, 3]);
      sp.setLinkCoord(0, 7, 8);
      expect(sp.linkCoord("C1")).toEqual([7, 8]);
      const ring = { shape: [4, 2], data: Float64Array.of(0, 0, 10, 0, 10, 10, 0, 0) };
      sp.setSubcatchmentPolygon("S1", ring);
      expect(Array.from(sp.subcatchmentPolygon("S1").data)).toEqual(Array.from(ring.data));
      sp.setSubcatchmentCoord("S1", 3, 4);
      expect(sp.subcatchmentCoord("S1")).toEqual([3, 4]);
      sp.setGageCoord("G1", 5, 6);
      expect(sp.gageCoord("G1")).toEqual([5, 6]);
      sp.mapDimensions = [0, 0, 1000, 500];
      expect(sp.mapDimensions).toEqual([0, 0, 1000, 500]);
      sp.mapUnits = "Meters";
      evidence.mapUnits = sp.mapUnits;
      expect(sp.mapUnits.toUpperCase()).toBe("METERS");
      sp.setAnnotation("LABELS", '10 20 "Outlet"');
      expect(sp.getAnnotation("LABELS")).toBe('10 20 "Outlet"');
      sp.setAnnotation("LABELS", null);
      expect(sp.getAnnotation("LABELS")).toBe("");
      expect(() => sp.nodeCoord("nope")).toThrow(pkg.ElementNotFoundError);
    } finally {
      solver.destroy();
    }
  });

  it("analyzes, deletes, restores, converts, splits and fuses", async () => {
    const { pkg, solver } = await opened();
    const { NodeType, LinkType, StaleObjectError } = pkg;
    try {
      const ed = solver.editor;
      expect(solver.editor).toBe(ed);
      const ids = solver.nodes.ids;
      evidence.analyzeJ2 = plain(ed.analyzeNodeImpact("J2"));
      expect(ed.nodeCount).toBe(4);

      const j3 = solver.nodes.get("J3");
      const [impacts, record] = ed.deleteNodeRecorded("J2");
      evidence.deleteJ2 = plain(impacts);
      expect(impacts.filter((e) => e.cascaded).map((e) => e.objTypeName)).toEqual(["link", "link"]);
      expect([ed.nodeCount, ed.linkCount]).toEqual([3, 1]);
      expect(() => j3.type).toThrow(StaleObjectError);
      expect(record.restorable).toBe(true);
      record.restore();
      expect(record.restorable).toBe(false);
      expect(() => record.restore()).toThrow(RangeError);
      record.close();
      expect([ed.nodeCount, ed.linkCount]).toEqual([4, 3]);
      expect(solver.nodes.ids).toEqual(ids);
      expect(solver.subcatchments.get("S2").outletNodeIndex).toBe(solver.nodes.getIndex("J2"));

      const [none, empty] = ed.deleteNodesRecorded([]);
      expect(none).toEqual([]);
      empty.restore();

      const conv = ed.convertNode("J3", NodeType.STORAGE);
      evidence.convertJ3 = [conv.newType, conv.clearedFields, conv.warnings];
      expect(conv.newType).toBe(NodeType.STORAGE);
      expect(solver.nodes.get("J3").type).toBe(NodeType.STORAGE);

      const preview = ed.convertTypes(false, LinkType.WEIR, [0, 1], { apply: false });
      evidence.previewWeir = preview.map((r) => [
        r.sourceType,
        r.status,
        r.dependencyNode,
        r.details.newType,
      ]);
      expect(preview).toHaveLength(2);
      expect(preview.every((r) => r.sourceType === LinkType.CONDUIT)).toBe(true);
      expect(solver.links.get(0).type).toBe(LinkType.CONDUIT);

      const [newNode, newLink] = ed.splitConduit("C2", 0.5, "J2a", "C2b", true);
      evidence.split = [newNode, newLink];
      expect(solver.nodes.getId(newNode)).toBe("J2a");
      expect(solver.links.getId(newLink)).toBe("C2b");
      expect(solver.links.get("C2").length).toBeCloseTo(200, 9);
      const surviving = ed.fuseVirtualJunction("J2a");
      evidence.fuse = surviving;
      expect(solver.links.getId(surviving)).toBe("C2");
      expect([ed.nodeCount, ed.linkCount]).toEqual([4, 3]);
      expect(solver.links.get("C2").length).toBeCloseTo(400, 9);

      expect(ed.startDatetime.getTime()).toBe(solver.startDatetime.getTime());
      const later = new Date(Date.UTC(2026, 0, 1, 0, 30));
      ed.reportStartDatetime = later;
      expect(ed.reportStartDatetime.getTime()).toBe(later.getTime());
      expect(() => ed.analyzeHydrographImpact("nope")).toThrow(pkg.EngineError);

      evidence.deleteGage = plain(ed.deleteGage("G1"));
      expect(ed.gageCount).toBe(0);
      evidence.deleteLinks = plain(ed.deleteLinks(["C3", 0]));
      expect(ed.linkCount).toBe(1);
      expect(ed.tableCount).toBe(1);
    } finally {
      solver.destroy();
    }
    expect(() => solver.editor).toThrow(pkg.BadHandleError);
  });

  it("edits a ModelBuilder and bumps its generation", async () => {
    const { mod, pkg } = await load();
    const { NodeType, LinkType } = pkg;
    using m = new pkg.ModelBuilder(mod);
    m.addNode("J1", NodeType.JUNCTION);
    m.addNode("J2", NodeType.JUNCTION);
    m.addNode("OUT1", NodeType.OUTFALL);
    m.addLink("C1", LinkType.CONDUIT);
    m.addLink("C2", LinkType.CONDUIT);
    m.setLinkNodes(0, 0, 1);
    m.setLinkNodes(1, 1, 2);
    const ed = new pkg.ModelEditor(m);
    const before = m.generation;
    const cascade = ed.deleteNode("J1");
    evidence.builderDeleteJ1 = plain(cascade);
    expect(cascade).toHaveLength(1);
    expect(cascade[0].objTypeName).toBe("link");
    expect(cascade[0].cascaded).toBe(true);
    expect(m.generation).toBeGreaterThan(before);
    expect([ed.nodeCount, ed.linkCount]).toEqual([2, 1]);
    const result = ed.convertLink("C2", LinkType.WEIR);
    expect(result.newType).toBe(LinkType.WEIR);

    const out = resolve(work, "d2");
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "wave_d2.json"), JSON.stringify(evidence, null, 1) + "\n");
  });
});
