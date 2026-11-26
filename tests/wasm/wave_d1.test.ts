/**
 * Real module, wave D part 1: OutputReader, Output2DReader and the Results
 * facade on tests/fixtures/smoke2d.inp (1D network plus a 2D surface whose
 * OUTPUT_FILE is found through Solver.openResults()).
 *
 * The run's .out and .h5 are copied to tests/_work/wasm/d1/ with
 * wave_d1_reads.json (values read here) so a native Python read of the same
 * files can be compared.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { built, fixtures, load, title, work } from "./load.js";

describe.skipIf(!built)(title("real module: wave D part 1 (results readers)"), () => {
  it("reads the .out and the 2D results file like Python", async () => {
    const { mod, pkg } = await load();
    const { OutNodeVar, OutLinkVar, OutSystemVar, StaleObjectError, slice, ELLIPSIS } = pkg;
    const solver = new pkg.Solver(mod);
    const out = resolve(work, "d1");
    mkdirSync(out, { recursive: true });
    try {
      solver.writeFile("/smoke2d.inp", readFileSync(resolve(fixtures, "smoke2d.inp"), "utf8"));
      solver.open("/smoke2d.inp", "/smoke2d.rpt", "/smoke2d.out");
      expect(() => solver.openResults()).toThrow(pkg.LifecycleError);
      solver.initialize();
      solver.start(true);
      while (solver.step() > 0) {
        /* run to the end */
      }
      const liveDepths = Array.from(solver.surface2d.getDepths());
      const nodeIds = solver.nodes.ids;
      solver.end();
      const reportStart = solver.reportStartDatetime.getTime();

      using results = solver.openResults();
      const reader = results.output!;
      writeFileSync(resolve(out, "smoke2d.out"), solver.readFile("/smoke2d.out"));
      writeFileSync(resolve(out, "smoke2d.h5"), solver.readFile("/2d_complete_example.h5"));

      // ---- OutputReader ----------------------------------------------------
      expect(reader.nodeIds).toEqual(nodeIds);
      expect(reader.linkIds).toEqual(solver.links.ids);
      expect(reader.errorCode).toBe(0);
      expect(reader.isLive).toBe(false);
      expect(reader.reportStep).toBe(300);
      const periods = reader.periodCount;
      expect(periods).toBe(72);
      const times = reader.periodTimes;
      expect(times[0].getTime()).toBe(reportStart + 300_000);
      expect(times[periods - 1].getTime() - times[0].getTime()).toBe((periods - 1) * 300_000);
      const last = periods - 1;
      const depthAll = reader.nodeResult(last, OutNodeVar.DEPTH);
      const j = nodeIds.length - 1;
      const series = reader.nodeSeries(nodeIds[j], OutNodeVar.DEPTH);
      expect(series).toHaveLength(periods);
      expect(series[last]).toBe(depthAll[j]);
      expect(reader.nodeSeries(j, OutNodeVar.DEPTH, { start: 10, end: 12 })).toEqual(
        series.slice(10, 13),
      );
      expect(() => reader.nodeSeries(j, OutNodeVar.DEPTH, { start: 5, end: 4 })).toThrow(
        RangeError,
      );
      expect(() => reader.nodeSeries("nope", OutNodeVar.DEPTH)).toThrow(pkg.ElementNotFoundError);
      const attrs = reader.nodeAttributes(j, last);
      expect(attrs.get(OutNodeVar.DEPTH)).toBe(depthAll[j]);
      expect(attrs.size).toBe(OutNodeVar.POLLUT_BASE + reader.pollutantCount);
      expect(reader.linkAttributes(0, last).get(OutLinkVar.FLOW)).toBe(
        reader.linkResult(last, OutLinkVar.FLOW)[0],
      );
      const rain = reader.systemSeries(OutSystemVar.RAINFALL);
      expect(reader.systemResult(4, OutSystemVar.RAINFALL)).toBe(rain[4]);
      const stats = reader.nodeStats(j);
      expect(stats.maxDepth).toBeCloseTo(Math.max(...series), 5);
      expect(stats.timeFlooded).toBeGreaterThanOrEqual(0);

      // ---- Results 1D fields -------------------------------------------------
      const depth = results.nodes!.variables.get("depth")!;
      expect(depth.units).toBe("m");
      expect(depth.dimensions).toEqual(["time", "object"]);
      expect(depth.shape).toEqual([periods, nodeIds.length]);
      const full = depth.read();
      expect(full.shape).toEqual([periods, nodeIds.length]);
      expect(Array.from(full.data.subarray(last * nodeIds.length))).toEqual(Array.from(depthAll));
      const two = depth.read({ objects: [nodeIds[j], 0], periods: slice(10, 13) });
      expect(two.shape).toEqual([3, 2]);
      expect(two.data[0]).toBe(series[10]);
      expect(depth.get(-1).data).toEqual(depthAll);
      expect(depth.get([ELLIPSIS, j]).data).toEqual(series);
      expect(() => depth.read({ selection: 0, periods: 0 })).toThrow(RangeError);
      const bound = results.nodes!.get(nodeIds[j]).variables.get("depth")!;
      expect(bound.dimensions).toEqual(["time"]);
      expect(bound.read().data).toEqual(series);
      expect(bound.read({ periods: 3 }).shape).toEqual([]);
      expect([...results.nodes!]).toEqual(nodeIds);
      expect(results.nodes!.length).toBe(nodeIds.length);
      expect(results.system!.variables.has("lat_inflow")).toBe(false); // alias of total_inflow
      expect(results.system!.variables.get("rainfall")!.read().data).toEqual(rain);
      expect(results.times).toHaveLength(periods);

      // ---- Output2DReader / SurfaceResults -------------------------------------
      expect(pkg.Output2DReader.available(mod)).toBe(true);
      const surface = results.surface!;
      const h5 = surface.reader;
      expect(h5.path).toBe("/2d_complete_example.h5");
      const cells = liveDepths.length;
      expect(surface.cells.length).toBe(cells);
      const sd = surface.variables.get("depth")!;
      expect(sd.path).toBe("/Mesh2_face_depth");
      expect(sd.dimensions).toEqual(["time", "cell"]);
      const [nt] = sd.shape;
      const sTimes = sd.times!;
      expect(sTimes).toHaveLength(nt);
      const lastRow = sd.read({ periods: -1 });
      expect(lastRow.shape).toEqual([cells]);
      const maxDiff = Math.max(
        ...Array.from(lastRow.data as Float64Array, (v, i) => Math.abs(v - liveDepths[i])),
      );
      expect(maxDiff).toBeLessThanOrEqual(1e-6);
      const all = sd.read();
      const pick = sd.read({ objects: [2, 0] });
      expect(pick.shape).toEqual([nt, 2]);
      expect(pick.data[2 * (nt - 1)]).toBe(all.data[(nt - 1) * cells + 2]);
      const reversed = sd.get([-1, slice(null, null, -1)]);
      expect(Array.from(reversed.data as Float64Array)).toEqual(
        Array.from(lastRow.data as Float64Array).reverse(),
      );
      const cell1 = sd.bind({ cell: 1 });
      expect(cell1.dimensions).toEqual(["time"]);
      expect(cell1.read().shape).toEqual([nt]);
      expect(() => sd.bind({ depth: 0 })).toThrow(RangeError);
      expect(h5.unlimitedAxes("/Mesh2_face_depth")).toEqual([0]);
      expect(h5.shape("/Mesh2_face_nodes")[1]).toBe("int64");
      const mesh = surface.mesh;
      expect(mesh.cells.shape[0]).toBe(cells);
      expect(mesh.vertices.shape[1]).toBe(3);
      expect(Array.from(mesh.vertexCounts).every((n) => n >= 3)).toBe(true);
      const mb = surface.massBalance;
      expect(mb.has("rainfall_in")).toBe(true);
      expect(surface.species.size).toBe(0);
      expect(surface.cells.get(0).species.size).toBe(0);
      expect(() => surface.field("nope")).toThrow(pkg.ElementNotFoundError);

      writeFileSync(
        resolve(out, "wave_d1_reads.json"),
        JSON.stringify(
          {
            periodTimes: times.map((d) => d.toISOString()),
            nodeIds,
            lastNodeDepth: Array.from(depthAll),
            nodeStats: {
              maxDepth: stats.maxDepth,
              maxOverflow: stats.maxOverflow,
              volFlooded: stats.volFlooded,
              timeFlooded: stats.timeFlooded,
            },
            surfaceTimes: sTimes.map((d) => d.toISOString()),
            surfaceLastDepth: Array.from(lastRow.data as Float64Array),
            meshCells: Array.from(mesh.cells.data),
            meshCounts: Array.from(mesh.vertexCounts),
            massBalance: Object.fromEntries(mb),
            depthUnits: sd.units,
            depthAttributes: sd.attributes,
          },
          null,
          1,
        ),
      );

      results.close();
      expect(() => reader.nodeCount).toThrow(StaleObjectError);
      expect(() => h5.datasets).toThrow(StaleObjectError);
    } finally {
      solver.destroy();
    }
  });
});
