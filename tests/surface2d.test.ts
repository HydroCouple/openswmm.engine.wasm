/**
 * @file surface2d.test.ts
 * @brief Unit tests for `Surface2D` / `Infiltration2D` against a heap-backed mock.
 *
 * @details The mock implements the Emscripten heap (one ArrayBuffer, a bump
 * allocator, getValue/setValue) and a two-triangle mesh behind the
 * `_swmm_2d_*` / `_swmm_infil2d_*` exports, so the tests exercise the real
 * out-parameter layouts, struct offsets (from the generated `STRUCTS`) and
 * argument order. tests/smoke/smoke2d.mjs runs the same class on the real
 * module.
 *
 * @license Apache-2.0
 */

import { describe, it, expect } from "vitest";

import {
  Solver,
  Surface2D,
  BadParamError,
  BadIndexError,
  ForcingPersist,
  SurfaceForcingMode,
  SurfaceInfilMethod,
  SurfaceInfilDest,
  STRUCTS,
} from "../src/js/index.js";
import type { OpenSwmmWasmModule } from "../src/js/index.js";

const ENGINE = 77;

interface Mock {
  mod: OpenSwmmWasmModule;
  calls: Array<[string, ...number[]]>;
  depths: Float64Array;
  cells: Map<number, Uint8Array>;
}

function makeMock(): Mock {
  const buffer = new ArrayBuffer(1 << 20);
  const HEAPU8 = new Uint8Array(buffer);
  const HEAP32 = new Int32Array(buffer);
  const HEAPF64 = new Float64Array(buffer);
  const view = new DataView(buffer);
  let next = 64;
  const calls: Mock["calls"] = [];
  const depths = new Float64Array([0.25, 0.5]);
  const cells = new Map<number, Uint8Array>();

  const i32 = (p: number, v: number) => view.setInt32(p, v, true);
  const f64 = (p: number, v: number) => view.setFloat64(p, v, true);
  const putStr = (p: number, s: string) => { HEAPU8.set(new TextEncoder().encode(s + "\0"), p); };
  const rowSize = STRUCTS.SWMM_Infil2DRow.size;

  const exports: Record<string, (...a: number[]) => unknown> = {
    _swmm_2d_is_active: (h, p) => { i32(p, 1); return 0; },
    _swmm_2d_vertex_count: (h, p) => { i32(p, 4); return 0; },
    _swmm_2d_triangle_count: (h, p) => { i32(p, 2); return 0; },
    _swmm_2d_cell_count: (h, p) => { i32(p, 2); return 0; },
    _swmm_2d_quad_count: (h, p) => { i32(p, 0); return 0; },
    _swmm_2d_edge_stride: (h, p) => { i32(p, 3); return 0; },
    _swmm_2d_get_depths_bulk: (h, p) => { HEAPF64.set(depths, p / 8); return 0; },
    _swmm_2d_get_edge_flux_bulk: (h, p) => { for (let k = 0; k < 6; k++) f64(p + 8 * k, k); return 0; },
    _swmm_2d_vertex_get_xyz_bulk: (h, x, y, z) => {
      for (let k = 0; k < 4; k++) { f64(x + 8 * k, k); f64(y + 8 * k, 10 + k); f64(z + 8 * k, 100 + k); }
      return 0;
    },
    _swmm_2d_triangle_get_vertices: (h, t, a, b, c) => {
      if (t > 1) return 8; // SWMM_ERR_BADINDEX
      i32(a, t); i32(b, t + 1); i32(c, t + 2); return 0;
    },
    _swmm_2d_cell_get_vertices: (h, t, v, nv) => { [0, 1, 2].forEach((x, k) => i32(v + 4 * k, x + t)); i32(nv, 3); return 0; },
    _swmm_2d_get_triangle_coupling_row: (h, r, tri, node, cd, area) => {
      i32(tri, 1); i32(node, 5); f64(cd, 0.6); f64(area, 2.5); return 0;
    },
    _swmm_2d_get_mass_balance: (h, ...ptrs) => { ptrs.forEach((p, k) => f64(p, k + 1)); return 0; },
    _swmm_2d_get_continuity_error: (h, p) => { f64(p, -0.25); return 0; },
    _swmm_2d_get_run_stats: (h, p) => {
      const f = STRUCTS.SWMM_2DRunStats.fields;
      putStr(p + f.backend.offset, "cpu (explicit marcher)");
      i32(p + f.momentum.offset, 2); i32(p + f.lts_tiers.offset, 4);
      i32(p + f.steps.offset, 1234); i32(p + f.face_evals.offset, 9876);
      f64(p + f.last_step.offset, 0.5);
      f64(p + f.active_frac_min.offset, 0.1); f64(p + f.active_frac_mean.offset, 0.2);
      f64(p + f.active_frac_max.offset, 0.3);
      i32(p + f.n_tiers.offset, 2); i32(p + f.tier_cells.offset, 7); i32(p + f.tier_cells.offset + 4, 3);
      return 0;
    },
    _swmm_2d_get_rainfall_weights: (h, cell, method, gages, weights, cap, count) => {
      // Cell 0: two gages; cell 1: one (an odd count once misaligned the doubles).
      const g = cell === 0 ? [3, 4] : [6];
      const w = cell === 0 ? [0.75, 0.25] : [1];
      i32(method, 1); i32(count, g.length);
      if (cap >= g.length) g.forEach((x, k) => { i32(gages + 4 * k, x); f64(weights + 8 * k, w[k]); });
      return 0;
    },
    _swmm_2d_set_vertex_z_bulk: (h, p, n) => { calls.push(["set_vertex_z_bulk", n, HEAPF64[p / 8]]); return 0; },
    _swmm_2d_force_rainfall: (h, i, v, mode, persist) => { calls.push(["force_rainfall", i, v, mode, persist]); return 0; },
    _swmm_2d_force_evap_uniform: (h, v, mode, persist) => { calls.push(["force_evap_uniform", v, mode, persist]); return 0; },
    _swmm_2d_output_variable_count: () => 2,
    _swmm_infil2d_set_cell: (h, tri, row) => {
      if (row) cells.set(tri, HEAPU8.slice(row, row + rowSize)); else cells.delete(tri);
      return 0;
    },
    _swmm_infil2d_get_cell: (h, tri, row, flag) => {
      const own = cells.get(tri);
      if (own) HEAPU8.set(own, row);
      i32(flag, own ? 1 : 0);
      return 0;
    },
    _swmm_infil2d_get_rate_bulk: (h, p, n) => { for (let k = 0; k < n; k++) f64(p + 8 * k, 1e-6 * (k + 1)); return 0; },
  };

  const strings: Record<string, (...a: unknown[]) => unknown> = {
    swmm_2d_output_variable_name: (i) => ["DEPTH", "VELOCITY"][i as number],
    swmm_2d_output_variable_mask: (text) => (text === "DEPTH" ? 1 : 0),
    swmm_2d_output_variable_text: (mask) => (mask === 1 ? "DEPTH" : ""),
    swmm_get_last_error_msg: () => "",
  };

  const mod = {
    HEAPU8, HEAP8: new Int8Array(buffer), HEAP32, HEAPU32: new Uint32Array(buffer),
    HEAPF32: new Float32Array(buffer), HEAPF64,
    FS: {} as never,
    _malloc: (n: number) => { const p = next; next += Math.ceil(n / 8) * 8 + 8; return p; },
    _free: () => {},
    getValue: (p: number, t: string) => (t === "double" ? view.getFloat64(p, true) : view.getInt32(p, true)),
    setValue: (p: number, v: number, t: string) => (t === "double" ? f64(p, v) : i32(p, v)),
    UTF8ToString: (p: number, max = 1 << 16) => {
      let e = p;
      while (e < p + max && HEAPU8[e] !== 0) e++;
      return new TextDecoder().decode(HEAPU8.subarray(p, e));
    },
    stringToUTF8: () => {},
    lengthBytesUTF8: (s: string) => s.length,
    cwrap: (name: string) => strings[name] ?? (() => { throw new Error(`no ${name}`); }),
    addFunction: () => 0,
    removeFunction: () => {},
    _swmm_engine_create: () => ENGINE,
    ...exports,
  } as unknown as OpenSwmmWasmModule;
  return { mod, calls, depths, cells };
}

describe("Solver.surface2d", () => {
  it("is a Surface2D on every solver", () => {
    const { mod } = makeMock();
    expect(new Solver(mod).surface2d).toBeInstanceOf(Surface2D);
  });
});

describe("Surface2D", () => {
  const surface = (m: Mock) => new Solver(m.mod).surface2d;

  it("reads mesh counts through int out-parameters", () => {
    const m = makeMock();
    const s = surface(m);
    expect([s.isActive, s.nVertices, s.nTriangles, s.nCells, s.nQuads, s.edgeStride]).toEqual([true, 4, 2, 2, 0, 3]);
  });

  it("returns per-cell arrays as copies sized by the cell count", () => {
    const m = makeMock();
    const d = surface(m).getDepths();
    expect(Array.from(d)).toEqual([0.25, 0.5]);
    expect(d.buffer).not.toBe(m.mod.HEAPF64.buffer);
    m.mod.HEAPF64.fill(9);
    expect(Array.from(d)).toEqual([0.25, 0.5]);
  });

  it("sizes edge arrays by cells x stride", () => {
    expect(surface(makeMock()).getEdgeFluxBulk().length).toBe(6);
  });

  it("splits the bulk vertex coordinates into x, y, z", () => {
    const c = surface(makeMock()).getVertexCoords();
    expect(Array.from(c.x)).toEqual([0, 1, 2, 3]);
    expect(Array.from(c.y)).toEqual([10, 11, 12, 13]);
    expect(Array.from(c.z)).toEqual([100, 101, 102, 103]);
  });

  it("maps connectivity and raises the engine error code", () => {
    const s = surface(makeMock());
    expect(s.getTriangleVertices(1)).toEqual([1, 2, 3]);
    expect(s.getCellVertices(0)).toEqual([0, 1, 2]);
    expect(() => s.getTriangleVertices(5)).toThrow(BadIndexError);
  });

  it("decodes a coupling row", () => {
    expect(surface(makeMock()).getTriangleCouplingRow(0)).toEqual({ triangle: 1, node: 5, cd: 0.6, area: 2.5 });
  });

  it("keeps the C argument order of the mass balance", () => {
    expect(surface(makeMock()).getMassBalance()).toEqual({
      initStorage: 1, finalStorage: 2, rainfallIn: 3, coupling1dTo2dIn: 4, coupling2dTo1dOut: 5,
      outfallIn: 6, outfallOut: 7, boundaryIn: 8, boundaryOut: 9, evapOut: 10, continuityError: -0.25,
    });
  });

  it("decodes SWMM_2DRunStats with the generated wasm32 layout", () => {
    expect(surface(makeMock()).runStats).toEqual({
      backend: "cpu (explicit marcher)", momentum: "DIFFUSIVE_WAVE", ltsTiers: 4, steps: 1234,
      faceEvals: 9876, lastStep: 0.5, activeFrac: [0.1, 0.2, 0.3], tierCells: [7, 3],
    });
  });

  it("reads rainfall weights in two passes", () => {
    const s = surface(makeMock());
    const w = s.rainfallWeights(0);
    expect(w.method).toBe(1);
    expect(Array.from(w.gages)).toEqual([3, 4]);
    expect(Array.from(w.weights)).toEqual([0.75, 0.25]);
    const one = s.rainfallWeights(1);
    expect(Array.from(one.gages)).toEqual([6]);
    expect(Array.from(one.weights)).toEqual([1]);
  });

  it("defaults forcing to OVERRIDE / RESET, as Python does", () => {
    const m = makeMock();
    const s = surface(m);
    s.forceRainfall(1, 2e-5);
    s.forceEvapUniform(1e-7, { mode: SurfaceForcingMode.ADD, persist: ForcingPersist.PERSIST });
    expect(m.calls).toEqual([
      ["force_rainfall", 1, 2e-5, SurfaceForcingMode.OVERRIDE, ForcingPersist.RESET],
      ["force_evap_uniform", 1e-7, SurfaceForcingMode.ADD, ForcingPersist.PERSIST],
    ]);
  });

  it("checks the vertex count before a bulk elevation write", () => {
    const m = makeMock();
    const s = surface(m);
    expect(() => s.setVertexZBulk([1, 2])).toThrow(BadParamError);
    s.setVertexZBulk([5, 6, 7, 8]);
    expect(m.calls).toEqual([["set_vertex_z_bulk", 4, 5]]);
  });

  it("wraps the REPORT_2D_VARIABLES vocabulary", () => {
    const s = surface(makeMock());
    expect(s.outputVariables()).toEqual(["DEPTH", "VELOCITY"]);
    expect(s.outputVariableMask("DEPTH")).toBe(1);
    expect(s.outputVariableText(1)).toBe("DEPTH");
    expect(() => s.outputVariableMask("NOPE")).toThrow(BadParamError);
  });
});

describe("Infiltration2D", () => {
  it("round-trips a cell row through SWMM_Infil2DRow", () => {
    const m = makeMock();
    const infil = new Solver(m.mod).surface2d.infiltration;
    expect(infil.cell(1)).toEqual({ row: { method: null, params: [0, 0, 0, 0, 0], dest: 0 }, isOverride: false });
    infil.setCell(1, { method: SurfaceInfilMethod.GREEN_AMPT, params: [4, 0.4, 0.3] });
    expect(infil.cell(1)).toEqual({
      row: { method: SurfaceInfilMethod.GREEN_AMPT, params: [4, 0.4, 0.3, 0, 0], dest: SurfaceInfilDest.LOST },
      isOverride: true,
    });
    infil.setCell(1, null);
    expect(infil.cell(1).isOverride).toBe(false);
  });

  it("refuses more parameters than the row holds", () => {
    const infil = new Solver(makeMock().mod).surface2d.infiltration;
    expect(() => infil.setCell(0, { method: SurfaceInfilMethod.HORTON, params: [1, 2, 3, 4, 5, 6] }))
      .toThrow(BadParamError);
  });

  it("treats an empty setCells as a no-op, as Python does", () => {
    const m = makeMock();
    new Solver(m.mod).surface2d.infiltration.setCells([], null);
    expect(m.cells.size).toBe(0);
  });

  it("reads the per-cell rate", () => {
    expect(Array.from(new Solver(makeMock().mod).surface2d.infiltration.rate())).toEqual([1e-6, 2e-6]);
  });
});
