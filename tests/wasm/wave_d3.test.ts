/**
 * Real module, wave D part 3: solver.infrastructure (transects, streets,
 * inlets, inlet placements, LID controls, storage-node stacks and
 * subcatchment placements).
 *
 * Decks: the engine's inlet round-trip fixture (streets, inlets, conduit and
 * junction placements), the Python LID node test's storage deck, and
 * tests/fixtures/smoke.inp for LID placements. Values read here go to
 * tests/_work/wasm/d3/wave_d3.json; tests/_work/wasm/d3/crosscheck.py (run by
 * hand) repeats the edits through native Python.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { built, fixtures, load, root, title, work } from "./load.js";

const INLET_DECK = resolve(
  root,
  "extern/openswmm.engine/tests/unit/engine/data/inp_roundtrip/inlet_clogging.inp",
);

/** The storage-node deck of the engine's python/tests/engine/test_lid_nodes.py. */
const LID_DECK = `[OPTIONS]
FLOW_UNITS CFS
FLOW_ROUTING DYNWAVE
START_DATE 01/01/2004
END_DATE 01/01/2004
END_TIME 00:01:00
ROUTING_STEP 00:00:01
REPORT_STEP 00:01:00
[POLLUTANTS]
TSS MG/L 0 0 0 0 NO * 0 0 0
[STORAGE]
S 0 2 0 FUNCTIONAL 0 0 100 0 0
[OUTFALLS]
O 0 FREE NO
[ORIFICES]
D S O BOTTOM 0 0.6 NO 0
[XSECTIONS]
D CIRCULAR .1 0 0 0
`;

async function opened(text: string) {
  const { mod, pkg } = await load();
  const solver = new pkg.Solver(mod);
  solver.writeFile("/deck.inp", text);
  solver.open("/deck.inp", "/deck.rpt", "/deck.out");
  return { mod, pkg, solver };
}

describe.skipIf(!built)(title("real module: wave D part 3 (infrastructure)"), () => {
  const evidence: Record<string, unknown> = {};
  afterAll(() => {
    const out = resolve(work, "d3");
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "wave_d3.json"), JSON.stringify(evidence, null, 1) + "\n");
  });

  it("edits streets, inlets, inlet placements and transects", async () => {
    const { pkg, solver } = await opened(readFileSync(INLET_DECK, "utf8"));
    const { InletHostKind, InletType } = pkg;
    try {
      const inf = solver.infrastructure;
      const streets = inf.streets;
      expect([...streets]).toEqual(["ST_A"]);
      evidence.streetA = streets.getParams(0);
      expect(streets.getParams(0)).toMatchObject({ tCrown: 20, sx: 4, sides: 2, backN: 0.016 });
      expect(streets.add("ST_B")).toBe(1);
      streets.setParams(1, { tCrown: 15, hCurb: 0.4, sx: 2, nRoad: 0.015 });
      evidence.streetB = streets.getParams(1);
      streets.rename("ST_B", "ST_C");
      expect(streets.has("ST_C") && streets.has(1) && !streets.has(2)).toBe(true);

      const inlets = inf.inlets;
      expect(inlets.getType(0)).toBe("GRATE");
      evidence.inletParams = inlets.getParams(0);
      expect(inlets.getParams(0)).toMatchObject({ length: 2, width: 2, grateType: "P_BAR-50" });
      const design = inlets.getDesign("IN_A");
      evidence.designA = design;
      inlets.setDesign("IN_A", { grateLength: 3 });
      expect(inlets.getDesign(0)).toEqual({ ...design, grateLength: 3 });
      evidence.curbNormalized = inlets.validateDesign({
        type: InletType.CURB,
        curbLength: 3,
        curbHeight: 0.5,
        throat: 0,
      });
      expect(() => inlets.setDesign(0, { curveId: "x".repeat(64) })).toThrow(RangeError);
      inlets.setComment("IN_A", "grate inlet");
      expect(inlets.getComment(0)).toBe("grate inlet");
      expect(inlets.add("IN_B", "CURB")).toBe(1);

      const usages = inf.inletUsages;
      expect(usages.length).toBe(3);
      const gut1 = solver.links.getIndex("GUT1");
      const row = usages.findLink(gut1);
      evidence.usageGut1 = usages.get(row);
      expect(usages.get(row)).toMatchObject({ hostKind: InletHostKind.LINK, pctClogged: 10 });
      const node = usages.findNode(solver.nodes.getIndex("IJ1"));
      expect(usages.get(node)).toMatchObject({ hostKind: InletHostKind.NODE, numInlets: 2 });
      usages.validate(usages.get(row));
      const st3 = solver.links.getIndex("ST3");
      const added = usages.set(InletHostKind.LINK, st3, 0, solver.nodes.getIndex("J5"), {
        numInlets: 2,
        pctClogged: 5,
      });
      evidence.usageSt3 = usages.get(added);
      expect(usages.findLink(st3)).toBe(added);
      expect([...usages]).toHaveLength(4);
      usages.remove(added);
      expect(usages.length).toBe(3);

      const tr = inf.transects;
      expect(tr.add("T1")).toBe(0);
      tr.setRoughness(0, 0.05, 0.06, 0.03);
      tr.addStation(0, 0, 10);
      tr.addStation(0, 50, 2);
      tr.addStation(0, 100, 10);
      tr.setBankStations(0, 20, 80);
      tr.setEncroachmentStations(0, 5, 95);
      tr.setModifiers(0, 1.1, 1.2, 1.3);
      tr.setComments(0, "channel");
      evidence.transect = {
        stations: tr.stations(0),
        roughness: tr.getRoughness(0),
        banks: tr.getBankStations(0),
        encroachment: tr.getEncroachmentStations(0),
        modifiers: tr.getModifiers(0),
        comments: tr.getComments(0),
      };
      expect(tr.stationCount(0)).toBe(3);
      expect(tr.getStation(0, 1)).toEqual([50, 2]);
      expect(tr.has(-1) && tr.has("T1") && !tr.has(1)).toBe(true);
      tr.rename(0, "T2");
      expect([...tr]).toEqual(["T2"]);
      tr.clearStations(0);
      expect(tr.stationCount(0)).toBe(0);
      tr.remove("T2");
      expect(tr.length).toBe(0);
    } finally {
      solver.destroy();
    }
  });

  it("authors storage-node LID stacks, anchors and snapshots", async () => {
    const { pkg, solver } = await opened(LID_DECK);
    const { LidType, LidNodeLayer, LidNodeLayerKind: K, LidLayerTreatment } = pkg;
    try {
      const lids = solver.infrastructure.lids;
      expect(lids.add("Stack", LidType.NODE)).toBe(0);
      const layers = [
        new LidNodeLayer(K.SURFACE, [6, 0.1]),
        ...Array.from(
          { length: 3 },
          () => new LidNodeLayer(K.MEDIA, [1, 0.45, 0.2, 0.08, 2, 10, 3]),
        ),
        new LidNodeLayer(K.AGGREGATE, [6, 0.4, 100]),
        new LidNodeLayer(K.BOTTOM, [0, 0]),
      ];
      expect(() => new LidNodeLayer(K.MEDIA, [1, 0.4])).toThrow(RangeError);
      const rules = [new LidLayerTreatment(2, "TSS", 25, 1.5, "R = 0.2")];
      lids.setLayers("Stack", layers, { treatments: rules });
      expect(lids.getLayers("Stack")).toEqual(layers);
      expect(lids.getTreatments(0)).toEqual(rules);
      evidence.flowOptions = lids.getFlowOptions(0);
      evidence.materials = lids.getMaterials(0);
      lids.validateLayers("Stack", layers, { flow: { model: 0 } });
      // Richards with the stack's (zero) retention materials is refused, as natively.
      expect(() => lids.validateLayers("Stack", layers, { flow: { model: 1 } })).toThrow(
        pkg.BadParamError,
      );

      lids.assignNode("S", "Stack", { initialSaturation: 25 });
      expect(lids.nodeAssignment("S")).toEqual([0, 25]);
      expect(lids.nodeAssignment("O")).toBeNull();
      expect(lids.nodeBottom("S")).toBe("CURRENT");
      lids.setNodeBottom("S", "sealed");
      expect(lids.nodeBottom("S")).toBe("SEALED");
      expect(() => lids.setNodeBottom("S", "unlimited")).toThrow(RangeError);
      lids.setOutletAnchor("D", 2);
      expect(lids.getOutletAnchor("D")).toEqual([2, "BOTTOM"]);
      expect(() => lids.setOutletAnchor("D", 1, { position: "MIDDLE" })).toThrow(RangeError);
      const snapshot = lids.nodeSnapshot("S");
      evidence.snapshot = snapshot;
      expect(snapshot.anchors).toHaveLength(1);
      evidence.prepared = lids.prepareNode("S", "Stack", { initialSaturation: 30 });
      lids.validateNode("S", snapshot);
      lids.replaceNode("S", snapshot);
      expect(lids.nodeAssignment("S")).toEqual([0, 25]);
      evidence.baseArea = lids.nodeBaseArea("S");

      solver.initialize();
      const profile = lids.nodeProfile("S");
      evidence.profileRows = profile.length;
      expect(profile.length).toBeGreaterThan(0);
      expect(profile.every((r) => r.top > r.bottom)).toBe(true);
      solver.close();
    } finally {
      solver.destroy();
    }
  });

  it("sets LID control layers and subcatchment placements", async () => {
    const { pkg, solver } = await opened(readFileSync(resolve(fixtures, "smoke.inp"), "utf8"));
    const { LidType, LidExtraField } = pkg;
    try {
      const lids = solver.infrastructure.lids;
      expect(lids.add("BC", LidType.BIO_CELL)).toBe(0);
      lids.setSurface(0, { storage: 6, roughness: 0.1, slope: 1 });
      lids.setSoil(0, { thick: 18, porosity: 0.5, fc: 0.2, wp: 0.1, ksat: 0.5, kslope: 10 });
      lids.setStorage(0, { thick: 12, voidFrac: 0.75, ksat: 0.5 });
      lids.setDrain(0, { coeff: 0, expon: 0.5, offset: 6 });
      expect(lids.add("PP", LidType.PERM_PAVEMENT)).toBe(1);
      lids.setPavement(1, { thick: 6, voidRatio: 0.15, fracImperv: 0, ksat: 100 });
      expect(lids.add("GR", LidType.GREEN_ROOF)).toBe(2);
      lids.setDrainmat(2, { thick: 3, voidFrac: 0.5, roughness: 0.1 });
      evidence.controls = {
        surface: lids.getSurface(0),
        soil: lids.getSoil(0),
        storage: lids.getStorage(0),
        drain: lids.getDrain(0),
        pavement: lids.getPavement(1),
        drainmat: lids.getDrainmat(2),
        types: [0, 1, 2].map((i) => lids.getType(i)),
        vegetation: lids.getExtra(0, LidExtraField.SURFACE_VEGETATION),
      };
      expect(lids.getSoil(0).kslope).toBe(10);
      lids.validateType(0, LidType.RAIN_GARDEN);
      lids.setExtra(0, LidExtraField.SURFACE_VEGETATION, 0.2);
      expect(lids.getExtra(0, LidExtraField.SURFACE_VEGETATION)).toBe(0.2);
      expect(lids.getDrainCurve(0)).toBe("");
      expect(() => lids.getDrainCurve(9)).toThrow(RangeError);

      lids.usageAdd("S1", 0, { number: 1, area: 100, width: 10, fromImperv: 25 });
      expect(lids.usageCount()).toBe(1);
      evidence.usage = lids.usageGet(0);
      const record = lids.usageRecord(0);
      evidence.usageRecord = record;
      lids.validateUsage(record);
      lids.replaceUsages("S1", [{ ...record, number: 2 }]);
      expect(lids.usageGet(0).number).toBe(2);
      lids.usageRemove(0);
      expect(lids.usageCount()).toBe(0);
      expect([...lids]).toEqual(["BC", "PP", "GR"]);
    } finally {
      solver.destroy();
    }
  });
});
