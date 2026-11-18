/**
 * Real module, wave E part 1: transport configuration and capability
 * matrices, thread information and the API catalog, on
 * tests/fixtures/smoke.inp and smoke2d.inp.
 *
 * Matrices and labels go to tests/_work/wasm/e1/wave_e1.json;
 * tests/_work/wasm/e1/crosscheck.py (run by hand) compares them with native
 * Python on the same decks.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { built, fixtures, load, title, work } from "./load.js";

type Matrix = Map<number, Map<number, { state: number; count: number; reason: string }>>;
const plain = (m: Matrix) =>
  Object.fromEntries(
    [...m].map(([d, row]) => [
      d,
      Object.fromEntries([...row].map(([c, v]) => [c, [v.state, v.count, v.reason]])),
    ]),
  );

async function opened(deck: string) {
  const { mod, pkg } = await load();
  const solver = new pkg.Solver(mod);
  solver.writeFile(`/${deck}`, readFileSync(resolve(fixtures, deck), "utf8"));
  solver.open(`/${deck}`, "/deck.rpt", "/deck.out");
  return { mod, pkg, solver };
}

describe.skipIf(!built)(title("real module: wave E part 1 (transport, threads, catalog)"), () => {
  const evidence: Record<string, unknown> = {};
  afterAll(() => {
    const out = resolve(work, "e1");
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "wave_e1.json"), JSON.stringify(evidence, null, 1) + "\n");
  });

  it("reads capability matrices, previews and labels", async () => {
    for (const deck of ["smoke.inp", "smoke2d.inp"]) {
      const { mod, pkg, solver } = await opened(deck);
      const { TransportDomain, TransportClass, TransportState } = pkg;
      try {
        const matrix = solver.transportMatrix;
        expect([...matrix.keys()]).toEqual([0, 1, 2, 3]);
        expect(
          matrix.get(TransportDomain.SURFACE_2D)!.get(TransportClass.POLLUTANTS),
        ).toBeInstanceOf(pkg.TransportCell);
        evidence[`matrix:${deck}`] = plain(matrix);
        const preview = solver.transport.previewMatrix({
          ignoreQuality: false,
          heat: true,
          age: 1,
          ignore2d: false,
          surfaceClasses: [true, false, true, true],
        });
        evidence[`preview:${deck}`] = plain(preview);
        expect(() =>
          solver.transport.previewMatrix({
            ignoreQuality: 0,
            heat: 0,
            age: 0,
            ignore2d: 0,
            surfaceClasses: [0, 0, 0] as unknown as [number, number, number, number],
          }),
        ).toThrow(RangeError);
        if (deck === "smoke.inp") {
          const cell = matrix.get(TransportDomain.NETWORK_1D)!.get(TransportClass.AGE)!;
          expect(cell.state).toBe(TransportState.UNAVAILABLE);
          expect(cell.reason).toBe("WATER_AGE OFF");
          evidence.domainNames = [0, 1, 2, 3].map((d) => pkg.transportDomainName(mod, d));
          evidence.classNames = [0, 1, 2, 3].map((c) => pkg.transportClassName(mod, c));
          expect(() => pkg.transportDomainName(mod, 9)).toThrow(RangeError);
        }
        const eff = solver.effectiveThreads();
        expect(eff.globalThreads).toBeGreaterThanOrEqual(1);
        evidence[`threads:${deck}`] = { info: solver.threadInfo, effective: eff };
      } finally {
        solver.destroy();
      }
    }
  });

  it("edits transport rows and options", async () => {
    const { pkg, solver } = await opened("smoke.inp");
    try {
      const t = solver.transport;
      t.setConduitDispersion(0, 0.5);
      expect(t.conduitDispersion).toEqual([{ linkIndex: 0, value: 0.5 }]);
      t.removeConduitDispersion(0);
      expect(t.conduitDispersion).toEqual([]);
      t.detailedOutput = "det.txt";
      expect(t.detailedOutput).toBe("det.txt");
      t.detailedOutput = null;
      expect(t.detailedOutput).toBe("");
      // Without a configured species the rows are refused, as natively.
      expect(() => t.setBoundary("J1", "X", 1.5)).toThrow(pkg.BadParamError);
      expect(() => t.setSource("C1", "X", 0.1, "TS1")).toThrow(pkg.BadParamError);
      expect([t.boundaries, t.sources]).toEqual([[], []]);
    } finally {
      solver.destroy();
    }
  });

  it("looks up, spells and resolves catalog paths", async () => {
    const { pkg, solver } = await opened("smoke.inp");
    const { catalog } = pkg;
    try {
      expect(catalog.revision()).toBeGreaterThanOrEqual(2);
      expect(() => catalog.requireRevision(1)).not.toThrow();
      expect(() => catalog.requireRevision(10_000, "test")).toThrow(/revision 10000/);
      expect(catalog.lookup("node.stats.max_depth").units).toBe("length");
      expect(() => catalog.lookup("node.no_such_member")).toThrow(pkg.ElementNotFoundError);
      expect(catalog.canonical("surface2d.groundwater.cells")).toBe("groundwater2d.cells");
      expect(catalog.members("node").length).toBeGreaterThan(10);
      expect(catalog.unitLabel("length", "SI")).toBe("m");
      expect(catalog.unitLabel("flow", null, pkg.FlowUnits.CFS)).toBe("CFS");
      expect(catalog.unitLabel("percent")).toBe("%");
      expect(catalog.UNIT_KINDS.has("land_area")).toBe(true);
      const stats = catalog.resolve(solver, "node.stats", "J1");
      expect(stats).toEqual(solver.nodes.get("J1").stats);
      expect(catalog.resolve(solver, "forcing")).toBe(solver.forcing);
      expect(() => catalog.resolve(solver, "node")).toThrow(RangeError);
      expect(() => catalog.resolve(solver, "builder")).toThrow(/standalone root/);
      // Every target reachable from a solver, by name: which resolve here.
      const reached: Record<string, boolean> = {};
      for (const [name, entry] of Object.entries(catalog.targets())) {
        if ("construct" in entry) continue;
        const key = String(entry.path).includes("[]") ? 0 : null;
        try {
          catalog.resolve(solver, name, key);
          reached[name] = true;
        } catch {
          reached[name] = false;
        }
      }
      evidence.resolvedTargets = reached;
    } finally {
      solver.destroy();
    }
  });
});
