/**
 * @file Surface2D.ts
 * @brief 2D surface routing for the OpenSWMM WASM bindings.
 *
 * @details Mirrors the Python `_2d.pyi` specification: {@link Surface2D} is
 * `solver.surface2d` (Python `Solver.surface2d`) and
 * {@link Infiltration2D} is `solver.surface2d.infiltration`. Method names are
 * the Python names in camelCase (`get_depths()` → `getDepths()`).
 *
 * The 2D module solves the depth-averaged shallow-water equations on an
 * unstructured triangle/quad mesh with the explicit local-inertial marcher,
 * coupled two-way to the 1D network. It is active once the model has a mesh
 * and {@link Solver.initialize} has run; before that, solver reads throw
 * {@link LifecycleError}.
 *
 * ### Units
 * The solver runs in SI whatever the model's flow units: depths and heads
 * are metres; rainfall, evaporation, net source and the per-cell 1D coupling
 * flux are rates in m/s (the coupling flux is per unit cell area); volumes are
 * m³ and the total exchange flow m³/s.
 *
 * ### Indexing
 * A "triangle index" is a cell index: triangles first, then quads. Per-cell
 * arrays have {@link Surface2D.nTriangles} entries; edge arrays have
 * `nTriangles * edgeStride` (stride 3 on an all-triangle mesh, 4 with quads).
 *
 * ### Results files
 * The WASM build has no HDF5 writer: `[2D_OPTIONS] OUTPUT_FILE` is ignored
 * with a warning in the report. Read results through this class instead.
 *
 * @author   Caleb Buahin <caleb.buahin@gmail.com>
 * @copyright Copyright (c) 2026 Caleb Buahin. All rights reserved.
 * @license  Apache-2.0
 */

import {
  ForcingPersist,
  SurfaceBoundaryType,
  SurfaceForcingMode,
  SurfaceInfilDest,
  SurfaceInfilMethod,
} from "./enums.js";
import { BadParamError, raiseForCode } from "./errors.js";
import type { OpenSwmmWasmModule } from "./types.js";
import { STRUCTS, type RawApi } from "./raw.js";
import { guardedRaw, withCString, withDouble, withDoubleArray, withDoubleInput, withInt } from "./mem.js";

/** How a forced 2D value combines with the computed one, and how long it lasts. */
export interface SurfaceForcingOptions {
  /** `OVERRIDE` (default) replaces the computed value; `ADD` adds to it. */
  readonly mode?: SurfaceForcingMode;
  /** `RESET` (default) applies for one step; `PERSIST` until cleared. */
  readonly persist?: ForcingPersist;
}

/** One row of the per-triangle 1D coupling table. */
export interface TriangleCouplingRow {
  readonly triangle: number;
  /** Coupled node index. */
  readonly node: number;
  /** Discharge coefficient. */
  readonly cd: number;
  /** Opening area (m²). */
  readonly area: number;
}

/** Gage weights that distribute rainfall onto one cell. */
export interface RainfallWeights {
  /** Interpolation method code (`[2D_OPTIONS] RAINFALL_MODE`). */
  readonly method: number;
  readonly gages: Int32Array;
  readonly weights: Float64Array;
}

/** Time-invariant edge geometry, `[cell * edgeStride + localEdge]`. */
export interface EdgeGeometry {
  readonly length: Float64Array;
  /** Outward unit normal, x component. */
  readonly nx: Float64Array;
  /** Outward unit normal, y component. */
  readonly ny: Float64Array;
}

/** 2D volume balance (m³) since the start of the run. */
export interface MassBalance2D {
  readonly initStorage: number;
  readonly finalStorage: number;
  readonly rainfallIn: number;
  readonly coupling1dTo2dIn: number;
  readonly coupling2dTo1dOut: number;
  readonly outfallIn: number;
  readonly outfallOut: number;
  readonly boundaryIn: number;
  readonly boundaryOut: number;
  readonly evapOut: number;
  /** Continuity error as a fraction, `(in - out) / in` (the report prints it ×100). */
  readonly continuityError: number;
}

/** Cumulative marcher statistics (Python `run_stats`). */
export interface RunStats2D {
  /** Solver label chosen at initialize, e.g. `"cpu (explicit marcher)"`. */
  readonly backend: string;
  /** `LOCAL_INERTIAL`, `FULL_SWE` or `DIFFUSIVE_WAVE` (the code if unknown). */
  readonly momentum: string | number;
  readonly ltsTiers: number;
  readonly steps: number;
  readonly faceEvals: number;
  /** Last accepted internal step (s). */
  readonly lastStep: number;
  /** Active-cell fraction `[min, mean, max]`; `-1` when not sampled. */
  readonly activeFrac: readonly [number, number, number];
  readonly tierCells: readonly number[];
}

/** One 2D infiltration specification (Python `Infil2DRow`). */
export interface Infil2DRow {
  /** `null` = no infiltration model. */
  readonly method: SurfaceInfilMethod | null;
  /** Positional parameters in project units, as legacy `[INFILTRATION]`. */
  readonly params?: readonly number[];
  readonly dest?: SurfaceInfilDest;
}

/** A cell's effective infiltration row (Python `Infil2DCell`). */
export interface Infil2DCell {
  readonly row: Infil2DRow;
  /** `true` when the cell has its own row rather than its tag's default. */
  readonly isOverride: boolean;
}

const MOMENTUM = ["LOCAL_INERTIAL", "FULL_SWE", "DIFFUSIVE_WAVE"] as const;
const TAG_BYTES = 256;

/** Scratch block for C out-parameters; freed after `use` returns. */
function scratch<T>(mod: OpenSwmmWasmModule, bytes: number, use: (p: number) => T): T {
  const p = mod._malloc(Math.max(bytes, 8));
  try {
    return use(p);
  } finally {
    mod._free(p);
  }
}

// =============================================================================
// Surface2D
// =============================================================================

/**
 * Read/write interface to the 2D surface routing module (`solver.surface2d`).
 *
 * @example
 * ```ts
 * solver.open("/model.inp", "/model.rpt", "/model.out");
 * solver.initialize();
 * const mesh = solver.surface2d;
 * if (mesh.isActive) {
 *   solver.start();
 *   while (solver.step() > 0) {
 *     const depths = mesh.getDepths();   // Float64Array, metres
 *   }
 * }
 * ```
 */
export class Surface2D {
  private readonly raw: RawApi;
  private _infiltration?: Infiltration2D;

  /** @internal Obtain through {@link Solver.surface2d}. */
  constructor(
    private readonly mod: OpenSwmmWasmModule,
    private readonly handle: number,
    checkOwner: () => void = () => {},
  ) {
    this.raw = guardedRaw(mod, checkOwner);
  }

  // ---- availability & editing ----------------------------------------------

  /** Whether the 2D solver is active (a mesh is present and initialize ran). */
  get isActive(): boolean {
    return withInt(this.mod, p => this.raw.swmm_2d_is_active(this.handle, p)) !== 0;
  }

  /** Re-open a mesh for editing between runs. */
  prepareForEdit(): void {
    raiseForCode(this.raw.swmm_2d_prepare_for_edit(this.handle));
  }

  // ---- mesh topology -------------------------------------------------------

  get nVertices(): number { return withInt(this.mod, p => this.raw.swmm_2d_vertex_count(this.handle, p)); }
  /** Number of cells (triangles + quads); every per-cell array has this length. */
  get nTriangles(): number { return withInt(this.mod, p => this.raw.swmm_2d_triangle_count(this.handle, p)); }
  /** Same value as {@link nTriangles}. */
  get nCells(): number { return withInt(this.mod, p => this.raw.swmm_2d_cell_count(this.handle, p)); }
  get nQuads(): number { return withInt(this.mod, p => this.raw.swmm_2d_quad_count(this.handle, p)); }
  /** Edge slots per cell in the bulk edge arrays: 3, or 4 once the mesh has a quad. */
  get edgeStride(): number { return withInt(this.mod, p => this.raw.swmm_2d_edge_stride(this.handle, p)); }

  getCellVertexCount(idx: number): number {
    return withInt(this.mod, p => this.raw.swmm_2d_cell_vertex_count(this.handle, idx, p));
  }

  /** Vertex indices of a cell (3 for a triangle, 4 for a quad). */
  getCellVertices(idx: number): number[] {
    return this.cellInts(idx, (v, nv) => this.raw.swmm_2d_cell_get_vertices(this.handle, idx, v, nv));
  }

  /** Neighbour cell across each local edge (`-1` on the boundary). */
  getCellNeighbours(idx: number): number[] {
    return this.cellInts(idx, (n, nv) => this.raw.swmm_2d_cell_get_neighbours(this.handle, idx, n, nv));
  }

  /** The three vertices of a triangle (refuses quads; use {@link getCellVertices}). */
  getTriangleVertices(idx: number): [number, number, number] {
    return this.ints3(p => this.raw.swmm_2d_triangle_get_vertices(this.handle, idx, p, p + 4, p + 8));
  }

  /** The three neighbours of a triangle (`-1` on the boundary). */
  getTriangleNeighbours(idx: number): [number, number, number] {
    return this.ints3(p => this.raw.swmm_2d_triangle_get_neighbours(this.handle, idx, p, p + 4, p + 8));
  }

  // ---- mesh geometry -------------------------------------------------------

  /** Vertex coordinates (metres after initialize). */
  getVertexCoords(): { x: Float64Array; y: Float64Array; z: Float64Array } {
    const n = this.nVertices;
    if (n <= 0) return { x: new Float64Array(0), y: new Float64Array(0), z: new Float64Array(0) };
    return scratch(this.mod, 24 * n, p => {
      raiseForCode(this.raw.swmm_2d_vertex_get_xyz_bulk(this.handle, p, p + 8 * n, p + 16 * n));
      const all = new Float64Array(this.mod.HEAPF64.buffer, p, 3 * n).slice();
      return { x: all.subarray(0, n), y: all.subarray(n, 2 * n), z: all.subarray(2 * n) };
    });
  }

  getVertexXyz(idx: number): [number, number, number] {
    return this.doubles3(p => this.raw.swmm_2d_vertex_get_xyz(this.handle, idx, p, p + 8, p + 16));
  }

  /** Set a vertex's ground elevation; derived cell geometry follows. */
  setVertexZ(idx: number, z: number): void {
    raiseForCode(this.raw.swmm_2d_set_vertex_z(this.handle, idx, z));
  }

  /** Set every vertex elevation at once (one value per vertex). */
  setVertexZBulk(z: ArrayLike<number>): void {
    const n = this.nVertices;
    if (z.length !== n) {
      throw new BadParamError(`setVertexZBulk expects one Z per vertex: got ${z.length}, mesh has ${n}`);
    }
    withDoubleInput(this.mod, z, (p, count) => this.raw.swmm_2d_set_vertex_z_bulk(this.handle, p, count));
  }

  getTriangleArea(idx: number): number {
    return withDouble(this.mod, p => this.raw.swmm_2d_triangle_get_area(this.handle, idx, p));
  }

  getTriangleCentroid(idx: number): [number, number, number] {
    return this.doubles3(p => this.raw.swmm_2d_triangle_get_centroid(this.handle, idx, p, p + 8, p + 16));
  }

  getTriangleMannings(idx: number): number {
    return withDouble(this.mod, p => this.raw.swmm_2d_triangle_get_mannings(this.handle, idx, p));
  }
  setTriangleMannings(idx: number, n: number): void {
    raiseForCode(this.raw.swmm_2d_set_triangle_mannings(this.handle, idx, n));
  }

  getTriangleInitDepth(idx: number): number {
    return withDouble(this.mod, p => this.raw.swmm_2d_triangle_get_init_depth(this.handle, idx, p));
  }
  setTriangleInitDepth(idx: number, depth: number): void {
    raiseForCode(this.raw.swmm_2d_set_triangle_init_depth(this.handle, idx, depth));
  }

  getTriangleInitVelocity(idx: number): [number, number] {
    return scratch(this.mod, 16, p => {
      raiseForCode(this.raw.swmm_2d_triangle_get_init_velocity(this.handle, idx, p, p + 8));
      return [this.mod.getValue(p, "double"), this.mod.getValue(p + 8, "double")];
    });
  }
  setTriangleInitVelocity(idx: number, u: number, v: number): void {
    raiseForCode(this.raw.swmm_2d_set_triangle_init_velocity(this.handle, idx, u, v));
  }

  getTriangleTag(idx: number): string {
    return withCString(this.mod, TAG_BYTES, (b, n) => this.raw.swmm_2d_get_triangle_tag(this.handle, idx, b, n));
  }
  setTriangleTag(idx: number, tag: string): void {
    raiseForCode(this.raw.swmm_2d_set_triangle_tag(this.handle, idx, tag));
  }

  getVertexTag(idx: number): string {
    return withCString(this.mod, TAG_BYTES, (b, n) => this.raw.swmm_2d_get_vertex_tag(this.handle, idx, b, n));
  }
  setVertexTag(idx: number, tag: string): void {
    raiseForCode(this.raw.swmm_2d_set_vertex_tag(this.handle, idx, tag));
  }

  // ---- 1D coupling ---------------------------------------------------------

  get vertexCouplingCount(): number {
    return withInt(this.mod, p => this.raw.swmm_2d_vertex_coupling_count(this.handle, p));
  }
  get triangleCouplingCount(): number {
    return withInt(this.mod, p => this.raw.swmm_2d_triangle_coupling_count(this.handle, p));
  }

  /** Node index coupled to a vertex, or `-1`. */
  getVertexCoupledNode(vertexIdx: number): number {
    return withInt(this.mod, p => this.raw.swmm_2d_vertex_get_coupled_node(this.handle, vertexIdx, p));
  }
  setVertexCoupledNode(vertexIdx: number, nodeName: string): void {
    raiseForCode(this.raw.swmm_2d_set_vertex_coupled_node(this.handle, vertexIdx, nodeName));
  }

  getVertexCouplingCd(vertexIdx: number): number {
    return withDouble(this.mod, p => this.raw.swmm_2d_get_vertex_coupling_cd(this.handle, vertexIdx, p));
  }
  setVertexCouplingCd(vertexIdx: number, cd: number): void {
    raiseForCode(this.raw.swmm_2d_set_vertex_coupling_cd(this.handle, vertexIdx, cd));
  }

  getVertexCouplingArea(vertexIdx: number): number {
    return withDouble(this.mod, p => this.raw.swmm_2d_get_vertex_coupling_area(this.handle, vertexIdx, p));
  }
  setVertexCouplingArea(vertexIdx: number, area: number): void {
    raiseForCode(this.raw.swmm_2d_set_vertex_coupling_area(this.handle, vertexIdx, area));
  }

  /** Node index coupled to a triangle, or `-1`. */
  getTriangleCoupledNode(triIdx: number): number {
    return withInt(this.mod, p => this.raw.swmm_2d_triangle_get_coupled_node(this.handle, triIdx, p));
  }
  addTriangleCoupling(triIdx: number, nodeName: string, cd: number, area: number): void {
    raiseForCode(this.raw.swmm_2d_add_triangle_coupling(this.handle, triIdx, nodeName, cd, area));
  }
  clearTriangleCouplings(): void {
    raiseForCode(this.raw.swmm_2d_clear_triangle_couplings(this.handle));
  }
  get triangleCouplingRows(): number {
    return withInt(this.mod, p => this.raw.swmm_2d_triangle_coupling_rows(this.handle, p));
  }
  getTriangleCouplingRow(rowIdx: number): TriangleCouplingRow {
    return scratch(this.mod, 24, p => {
      raiseForCode(this.raw.swmm_2d_get_triangle_coupling_row(this.handle, rowIdx, p, p + 4, p + 8, p + 16));
      return {
        triangle: this.mod.getValue(p, "i32"),
        node: this.mod.getValue(p + 4, "i32"),
        cd: this.mod.getValue(p + 8, "double"),
        area: this.mod.getValue(p + 16, "double"),
      };
    });
  }

  // ---- state: per-cell arrays (copies) ---------------------------------------

  /** Water depth per cell (m). */
  getDepths(): Float64Array { return this.cellArray(p => this.raw.swmm_2d_get_depths_bulk(this.handle, p)); }
  /** Water-surface elevation per cell (m). */
  getHeads(): Float64Array { return this.cellArray(p => this.raw.swmm_2d_get_heads_bulk(this.handle, p)); }
  /** 1D coupling flux per cell (m/s per unit cell area, positive into the surface). */
  getCouplingFluxes(): Float64Array {
    return this.cellArray(p => this.raw.swmm_2d_get_coupling_fluxes_bulk(this.handle, p));
  }
  /** Rainfall rate per cell (m/s). */
  getRainfallBulk(): Float64Array { return this.cellArray(p => this.raw.swmm_2d_get_rainfall_bulk(this.handle, p)); }
  /** Cumulative rainfall volume per cell (m³). */
  getRainVolumeBulk(): Float64Array {
    return this.cellArray(p => this.raw.swmm_2d_get_rain_volume_bulk(this.handle, p));
  }
  /** Cumulative 1D-exchange volume per cell (m³). */
  getCouplingVolumeBulk(): Float64Array {
    return this.cellArray(p => this.raw.swmm_2d_get_coupling_volume_bulk(this.handle, p));
  }
  /** Maximum depth reached per cell (m). */
  getStatMaxDepths(): Float64Array {
    return this.cellArray(p => this.raw.swmm_2d_get_stat_max_depths(this.handle, p));
  }
  /** Maximum velocity magnitude per cell (m/s). */
  getStatMaxVelocities(): Float64Array {
    return this.cellArray(p => this.raw.swmm_2d_get_stat_max_velocities(this.handle, p));
  }
  /** Maximum per-cell continuity error. */
  getStatMaxContinuityErr(): Float64Array {
    return this.cellArray(p => this.raw.swmm_2d_get_stat_max_continuity_err(this.handle, p));
  }

  // ---- state: edge and vertex arrays -----------------------------------------

  /** Depth-integrated normal flux per edge slot (m²/s, positive leaving the cell). */
  getEdgeFluxBulk(): Float64Array {
    return this.edgeArray(p => this.raw.swmm_2d_get_edge_flux_bulk(this.handle, p));
  }

  /** Edge length and outward unit normal per edge slot. */
  getEdgeGeometryBulk(): EdgeGeometry {
    const n = this.nTriangles * this.edgeStride;
    if (n <= 0) return { length: new Float64Array(0), nx: new Float64Array(0), ny: new Float64Array(0) };
    return scratch(this.mod, 24 * n, p => {
      raiseForCode(this.raw.swmm_2d_edge_get_geometry_bulk(this.handle, p, p + 8 * n, p + 16 * n));
      const all = new Float64Array(this.mod.HEAPF64.buffer, p, 3 * n).slice();
      return { length: all.subarray(0, n), nx: all.subarray(n, 2 * n), ny: all.subarray(2 * n) };
    });
  }

  /** Edge conveyance multipliers per edge slot (1 = unrestricted). */
  getEdgeConveyanceBulk(): Float64Array {
    return this.edgeArray(p => this.raw.swmm_2d_get_edge_conveyance_bulk(this.handle, p));
  }

  /** Reconstructed water-surface elevation per vertex (m). */
  getVertexHeads(): Float64Array {
    return withDoubleArray(this.mod, this.nVertices, p => this.raw.swmm_2d_vertex_get_heads_bulk(this.handle, p));
  }

  /** Depth per vertex for rendering (m). */
  getVertexRenderDepths(): Float64Array {
    return withDoubleArray(this.mod, this.nVertices,
      p => this.raw.swmm_2d_vertex_get_render_depths_bulk(this.handle, p));
  }

  // ---- state: single values --------------------------------------------------

  getDepth(idx: number): number { return withDouble(this.mod, p => this.raw.swmm_2d_get_depth(this.handle, idx, p)); }
  getHead(idx: number): number { return withDouble(this.mod, p => this.raw.swmm_2d_get_head(this.handle, idx, p)); }
  getRainfall(idx: number): number {
    return withDouble(this.mod, p => this.raw.swmm_2d_get_rainfall(this.handle, idx, p));
  }
  /** Net source/sink rate (m/s). */
  getNetSource(idx: number): number {
    return withDouble(this.mod, p => this.raw.swmm_2d_get_net_source(this.handle, idx, p));
  }
  getCouplingFlux(idx: number): number {
    return withDouble(this.mod, p => this.raw.swmm_2d_get_coupling_flux(this.handle, idx, p));
  }
  getVertexHead(idx: number): number {
    return withDouble(this.mod, p => this.raw.swmm_2d_vertex_get_head(this.handle, idx, p));
  }

  /** Gages and weights that distribute rainfall onto `cell`. */
  rainfallWeights(cell: number): RainfallWeights {
    return scratch(this.mod, 8, hdr => {
      raiseForCode(this.raw.swmm_2d_get_rainfall_weights(this.handle, cell, hdr, 0, 0, 0, hdr + 4));
      const count = this.mod.getValue(hdr + 4, "i32");
      if (count <= 0) {
        return { method: this.mod.getValue(hdr, "i32"), gages: new Int32Array(0), weights: new Float64Array(0) };
      }
      // Doubles first: the block is 8-byte aligned, the ints after it need 4.
      return scratch(this.mod, 12 * count, w => {
        const g = w + 8 * count;
        raiseForCode(this.raw.swmm_2d_get_rainfall_weights(this.handle, cell, hdr, g, w, count, hdr + 4));
        const n = Math.min(count, this.mod.getValue(hdr + 4, "i32"));
        return {
          method: this.mod.getValue(hdr, "i32"),
          gages: new Int32Array(this.mod.HEAP32.buffer, g, n).slice(),
          weights: new Float64Array(this.mod.HEAPF64.buffer, w, n).slice(),
        };
      });
    });
  }

  // ---- run summary ------------------------------------------------------------

  /** Largest cell depth right now (m). */
  get maxDepth(): number { return withDouble(this.mod, p => this.raw.swmm_2d_get_max_depth(this.handle, p)); }
  /** Water volume on the surface (m³). */
  get totalVolume(): number { return withDouble(this.mod, p => this.raw.swmm_2d_get_total_volume(this.handle, p)); }
  /** Sum of the 1D coupling flows (m³/s, positive from the surface into the 1D network). */
  get totalExchangeFlow(): number {
    return withDouble(this.mod, p => this.raw.swmm_2d_get_total_exchange_flow(this.handle, p));
  }
  /** Internal marcher steps taken in the last advance. */
  get solverSteps(): number {
    // `long` is 32-bit on wasm32; the count is never negative.
    return withInt(this.mod, p => this.raw.swmm_2d_get_solver_steps(this.handle, p)) >>> 0;
  }
  /** Last accepted internal step (s). */
  get solverLastStep(): number {
    return withDouble(this.mod, p => this.raw.swmm_2d_get_solver_last_step(this.handle, p));
  }
  /** Continuity error of the 2D volume balance as a fraction, `(in - out) / in`. */
  get continuityError(): number {
    return withDouble(this.mod, p => this.raw.swmm_2d_get_continuity_error(this.handle, p));
  }

  get runStats(): RunStats2D {
    const s = STRUCTS.SWMM_2DRunStats;
    const f = s.fields;
    return scratch(this.mod, s.size, p => {
      this.mod.HEAPU8.fill(0, p, p + s.size);
      raiseForCode(this.raw.swmm_2d_get_run_stats(this.handle, p));
      const i32 = (o: number) => this.mod.getValue(p + o, "i32");
      const f64 = (o: number) => this.mod.getValue(p + o, "double");
      const momentum = i32(f.momentum.offset);
      const nTiers = Math.max(0, Math.min(i32(f.n_tiers.offset), 8));
      return {
        backend: this.mod.UTF8ToString(p + f.backend.offset, 64),
        momentum: momentum >= 0 && momentum < MOMENTUM.length ? MOMENTUM[momentum] : momentum,
        ltsTiers: i32(f.lts_tiers.offset),
        steps: i32(f.steps.offset) >>> 0,
        faceEvals: i32(f.face_evals.offset) >>> 0,
        lastStep: f64(f.last_step.offset),
        activeFrac: [f64(f.active_frac_min.offset), f64(f.active_frac_mean.offset), f64(f.active_frac_max.offset)],
        tierCells: Array.from({ length: nTiers }, (_, k) => i32(f.tier_cells.offset + 4 * k) >>> 0),
      };
    });
  }

  /** 2D volume balance (m³) and its continuity error (a fraction). */
  getMassBalance(): MassBalance2D {
    const v = scratch(this.mod, 80, p => {
      raiseForCode(this.raw.swmm_2d_get_mass_balance(this.handle,
        p, p + 8, p + 16, p + 24, p + 32, p + 40, p + 48, p + 56, p + 64, p + 72));
      return Array.from({ length: 10 }, (_, k) => this.mod.getValue(p + 8 * k, "double"));
    });
    return {
      initStorage: v[0], finalStorage: v[1], rainfallIn: v[2],
      coupling1dTo2dIn: v[3], coupling2dTo1dOut: v[4],
      outfallIn: v[5], outfallOut: v[6], boundaryIn: v[7], boundaryOut: v[8], evapOut: v[9],
      continuityError: this.continuityError,
    };
  }

  // ---- runtime forcing --------------------------------------------------------

  /** Force the rainfall rate (m/s) on one cell. */
  forceRainfall(idx: number, value: number, opts: SurfaceForcingOptions = {}): void {
    const [mode, persist] = forcing(opts);
    raiseForCode(this.raw.swmm_2d_force_rainfall(this.handle, idx, value, mode, persist));
  }
  /** Force the same rainfall rate (m/s) on every cell. */
  forceRainfallUniform(value: number, opts: SurfaceForcingOptions = {}): void {
    const [mode, persist] = forcing(opts);
    raiseForCode(this.raw.swmm_2d_force_rainfall_uniform(this.handle, value, mode, persist));
  }
  /** Force an evaporation demand (m/s) on one cell; dry cells stop losing water. */
  forceEvap(idx: number, value: number, opts: SurfaceForcingOptions = {}): void {
    const [mode, persist] = forcing(opts);
    raiseForCode(this.raw.swmm_2d_force_evap(this.handle, idx, value, mode, persist));
  }
  forceEvapUniform(value: number, opts: SurfaceForcingOptions = {}): void {
    const [mode, persist] = forcing(opts);
    raiseForCode(this.raw.swmm_2d_force_evap_uniform(this.handle, value, mode, persist));
  }
  /** Force the 1D coupling flux of one cell (m/s per unit cell area, positive into the surface). */
  forceCouplingFlux(idx: number, value: number, opts: SurfaceForcingOptions = {}): void {
    const [mode, persist] = forcing(opts);
    raiseForCode(this.raw.swmm_2d_force_coupling_flux(this.handle, idx, value, mode, persist));
  }
  forceClearAll(): void {
    raiseForCode(this.raw.swmm_2d_force_clear_all(this.handle));
  }

  /** Depth below which a cell is treated as dry (m). */
  get dryDepth(): number { return withDouble(this.mod, p => this.raw.swmm_2d_get_dry_depth(this.handle, p)); }
  set dryDepth(value: number) { raiseForCode(this.raw.swmm_2d_set_dry_depth(this.handle, value)); }

  // ---- boundary conditions ------------------------------------------------------

  get boundaryEdgeCount(): number {
    return withInt(this.mod, p => this.raw.swmm_2d_boundary_edge_count(this.handle, p));
  }

  getEdgeBcType(triIdx: number, edge: number): SurfaceBoundaryType {
    return withInt(this.mod, p => this.raw.swmm_2d_get_edge_bc_type(this.handle, triIdx, edge, p));
  }
  setEdgeBcType(triIdx: number, edge: number, bcType: SurfaceBoundaryType): void {
    raiseForCode(this.raw.swmm_2d_set_edge_bc_type(this.handle, triIdx, edge, bcType));
  }

  /** Specified stage (m). */
  getEdgeBcHead(triIdx: number, edge: number): number {
    return withDouble(this.mod, p => this.raw.swmm_2d_get_edge_bc_head(this.handle, triIdx, edge, p));
  }
  setEdgeBcHead(triIdx: number, edge: number, head: number): void {
    raiseForCode(this.raw.swmm_2d_set_edge_bc_head(this.handle, triIdx, edge, head));
  }

  /** Normal-flow slope. */
  getEdgeBcSlope(triIdx: number, edge: number): number {
    return withDouble(this.mod, p => this.raw.swmm_2d_get_edge_bc_slope(this.handle, triIdx, edge, p));
  }
  setEdgeBcSlope(triIdx: number, edge: number, slope: number): void {
    raiseForCode(this.raw.swmm_2d_set_edge_bc_slope(this.handle, triIdx, edge, slope));
  }

  /** Specified flow (m³/s). */
  getEdgeBcFlow(triIdx: number, edge: number): number {
    return withDouble(this.mod, p => this.raw.swmm_2d_get_edge_bc_flow(this.handle, triIdx, edge, p));
  }
  setEdgeBcFlow(triIdx: number, edge: number, flow: number): void {
    raiseForCode(this.raw.swmm_2d_set_edge_bc_flow(this.handle, triIdx, edge, flow));
  }

  /** Cumulative volume through a boundary edge (m³, positive leaving). */
  getEdgeBcCumFlux(triIdx: number, edge: number): number {
    return withDouble(this.mod, p => this.raw.swmm_2d_get_edge_bc_cum_flux(this.handle, triIdx, edge, p));
  }

  getEdgeBcTseriesName(triIdx: number, edge: number): string {
    return withCString(this.mod, TAG_BYTES,
      (b, n) => this.raw.swmm_2d_get_edge_bc_tseries_name(this.handle, triIdx, edge, b, n));
  }
  setEdgeBcTseriesName(triIdx: number, edge: number, name: string): void {
    raiseForCode(this.raw.swmm_2d_set_edge_bc_tseries_name(this.handle, triIdx, edge, name));
  }

  getEdgeBcFlowTseriesName(triIdx: number, edge: number): string {
    return withCString(this.mod, TAG_BYTES,
      (b, n) => this.raw.swmm_2d_get_edge_bc_flow_tseries_name(this.handle, triIdx, edge, b, n));
  }
  setEdgeBcFlowTseriesName(triIdx: number, edge: number, name: string): void {
    raiseForCode(this.raw.swmm_2d_set_edge_bc_flow_tseries_name(this.handle, triIdx, edge, name));
  }

  getEdgeBcRatingCurveName(triIdx: number, edge: number): string {
    return withCString(this.mod, TAG_BYTES,
      (b, n) => this.raw.swmm_2d_get_edge_bc_rating_curve_name(this.handle, triIdx, edge, b, n));
  }
  setEdgeBcRatingCurveName(triIdx: number, edge: number, name: string): void {
    raiseForCode(this.raw.swmm_2d_set_edge_bc_rating_curve_name(this.handle, triIdx, edge, name));
  }

  // ---- edge conveyance ------------------------------------------------------------

  getEdgeConveyance(tri: number, edge: number): number {
    return withDouble(this.mod, p => this.raw.swmm_2d_get_edge_conveyance(this.handle, tri, edge, p));
  }
  setEdgeConveyance(tri: number, edge: number, conveyance: number): void {
    raiseForCode(this.raw.swmm_2d_set_edge_conveyance(this.handle, tri, edge, conveyance));
  }
  resetEdgeConveyance(): void {
    raiseForCode(this.raw.swmm_2d_reset_edge_conveyance(this.handle));
  }

  // ---- REPORT_2D_VARIABLES vocabulary -------------------------------------------

  /** Variable names accepted by `[2D_OPTIONS] REPORT_2D_VARIABLES`. */
  outputVariables(): string[] {
    const n = this.raw.swmm_2d_output_variable_count();
    return Array.from({ length: n }, (_, i) => this.raw.swmm_2d_output_variable_name(i));
  }

  /** Bit mask for a variable selection such as `"DEPTH HEAD"`; throws on an invalid one. */
  outputVariableMask(text: string): number {
    const mask = this.raw.swmm_2d_output_variable_mask(text) >>> 0;
    if (!mask) throw new BadParamError(`Invalid or empty 2D output variable selection: ${text}`);
    return mask;
  }

  /** The canonical selection text for a mask. */
  outputVariableText(mask: number): string {
    return this.raw.swmm_2d_output_variable_text(mask >>> 0) ?? "";
  }

  // ---- sub-views ---------------------------------------------------------------------

  /** Per-cell infiltration on the mesh (Python `surface2d.infiltration`). */
  get infiltration(): Infiltration2D {
    this._infiltration ??= new Infiltration2D(this.mod, this.handle, this.raw);
    return this._infiltration;
  }

  // ---- helpers -------------------------------------------------------------------------

  private cellArray(call: (p: number) => number): Float64Array {
    return withDoubleArray(this.mod, this.nTriangles, call);
  }

  private edgeArray(call: (p: number) => number): Float64Array {
    return withDoubleArray(this.mod, this.nTriangles * this.edgeStride, call);
  }

  private cellInts(_idx: number, call: (v: number, nv: number) => number): number[] {
    return scratch(this.mod, 20, p => {
      raiseForCode(call(p, p + 16));
      const nv = Math.max(0, Math.min(this.mod.getValue(p + 16, "i32"), 4));
      return Array.from({ length: nv }, (_, k) => this.mod.getValue(p + 4 * k, "i32"));
    });
  }

  private ints3(call: (p: number) => number): [number, number, number] {
    return scratch(this.mod, 12, p => {
      raiseForCode(call(p));
      return [this.mod.getValue(p, "i32"), this.mod.getValue(p + 4, "i32"), this.mod.getValue(p + 8, "i32")];
    });
  }

  private doubles3(call: (p: number) => number): [number, number, number] {
    return scratch(this.mod, 24, p => {
      raiseForCode(call(p));
      return [this.mod.getValue(p, "double"), this.mod.getValue(p + 8, "double"), this.mod.getValue(p + 16, "double")];
    });
  }
}

function forcing(opts: SurfaceForcingOptions): [number, number] {
  return [opts.mode ?? SurfaceForcingMode.OVERRIDE, opts.persist ?? ForcingPersist.RESET];
}

// =============================================================================
// Infiltration2D
// =============================================================================

const ROW = STRUCTS.SWMM_Infil2DRow;
const MAX_PARAMS = ROW.fields.p.count;

/**
 * Per-cell infiltration on the 2D mesh (`solver.surface2d.infiltration`).
 *
 * Rows are positional and in project units, as legacy `[INFILTRATION]`
 * (see {@link Infil2DRow}). Defaults are keyed by triangle tag; a cell's own
 * row overrides its tag's default. Rows can change until initialize.
 */
export class Infiltration2D {
  /** @internal Obtain through {@link Surface2D.infiltration}. */
  constructor(
    private readonly mod: OpenSwmmWasmModule,
    private readonly handle: number,
    private readonly raw: RawApi,
  ) {}

  /** Evaluation cadence (s); `<= 0` uses the project `WET_STEP`. */
  get infilStep(): number {
    return withDouble(this.mod, p => this.raw.swmm_infil2d_get_options(this.handle, p));
  }
  set infilStep(seconds: number) {
    scratch(this.mod, STRUCTS.SWMM_Infil2DOptions.size, p => {
      this.mod.setValue(p + STRUCTS.SWMM_Infil2DOptions.fields.infil_step.offset, seconds, "double");
      raiseForCode(this.raw.swmm_infil2d_set_options(this.handle, p));
    });
  }

  /** Tag-keyed default rows (Python `defaults`, a mapping). */
  get defaults(): Map<string, Infil2DRow> {
    const n = withInt(this.mod, p => this.raw.swmm_infil2d_defaults_count(this.handle, p));
    const out = new Map<string, Infil2DRow>();
    for (let i = 0; i < n; i++) {
      const tag = withCString(this.mod, TAG_BYTES,
        (b, len) => this.raw.swmm_infil2d_get_default_tag(this.handle, i, b, len));
      out.set(tag, this.readRow(p => this.raw.swmm_infil2d_get_default(this.handle, i, p)));
    }
    return out;
  }

  /** Set (or with `null`, remove) the default row for a triangle tag. */
  setDefault(tag: string, row: Infil2DRow | null): void {
    if (row === null) {
      raiseForCode(this.raw.swmm_infil2d_remove_default(this.handle, tag));
      return;
    }
    this.withRow(row, p => this.raw.swmm_infil2d_set_default(this.handle, tag, p));
  }

  /** The cell's effective row and whether it is the cell's own. */
  cell(tri: number): Infil2DCell {
    return scratch(this.mod, 4, flag => {
      const row = this.readRow(p => this.raw.swmm_infil2d_get_cell(this.handle, tri, p, flag));
      return { row, isOverride: this.mod.getValue(flag, "i32") !== 0 };
    });
  }

  /** Give a cell its own row, or with `null` return it to its tag's default. */
  setCell(tri: number, row: Infil2DRow | null): void {
    if (row === null) {
      raiseForCode(this.raw.swmm_infil2d_set_cell(this.handle, tri, 0));
      return;
    }
    this.withRow(row, p => this.raw.swmm_infil2d_set_cell(this.handle, tri, p));
  }

  /** {@link setCell} for many cells at once. */
  setCells(tris: ArrayLike<number>, row: Infil2DRow | null): void {
    const n = tris.length;
    if (n === 0) return;   // as Python: nothing to set
    scratch(this.mod, 4 * n, t => {
      this.mod.HEAP32.set(Array.from(tris), t / 4);
      if (row === null) {
        raiseForCode(this.raw.swmm_infil2d_set_cells(this.handle, t, n, 0));
      } else {
        this.withRow(row, p => this.raw.swmm_infil2d_set_cells(this.handle, t, n, p));
      }
    });
  }

  /** Current infiltration rate per cell (m/s). */
  rate(): Float64Array {
    const n = withInt(this.mod, p => this.raw.swmm_2d_triangle_count(this.handle, p));
    return withDoubleArray(this.mod, n, p => this.raw.swmm_infil2d_get_rate_bulk(this.handle, p, n));
  }

  /** Cumulative infiltrated depth per cell (m). */
  cumulative(): Float64Array {
    const n = withInt(this.mod, p => this.raw.swmm_2d_triangle_count(this.handle, p));
    return withDoubleArray(this.mod, n, p => this.raw.swmm_infil2d_get_cum_bulk(this.handle, p, n));
  }

  /** Total infiltrated volume (m³). */
  get totalVolume(): number {
    return withDouble(this.mod, p => this.raw.swmm_infil2d_get_total_volume(this.handle, p));
  }

  private readRow(call: (p: number) => number): Infil2DRow {
    return scratch(this.mod, ROW.size, p => {
      this.mod.HEAPU8.fill(0, p, p + ROW.size);
      raiseForCode(call(p));
      const has = this.mod.getValue(p + ROW.fields.has_method.offset, "i32") !== 0;
      const params = Array.from({ length: MAX_PARAMS },
        (_, k) => this.mod.getValue(p + ROW.fields.p.offset + 8 * k, "double"));
      return {
        method: has ? this.mod.getValue(p + ROW.fields.method.offset, "i32") as SurfaceInfilMethod : null,
        params,
        dest: has ? this.mod.getValue(p + ROW.fields.dest.offset, "i32") as SurfaceInfilDest : SurfaceInfilDest.LOST,
      };
    });
  }

  private withRow(row: Infil2DRow, call: (p: number) => number): void {
    const params = row.params ?? [];
    if (params.length > MAX_PARAMS) {
      throw new BadParamError(`an infiltration row takes at most ${MAX_PARAMS} parameters`);
    }
    scratch(this.mod, ROW.size, p => {
      this.mod.HEAPU8.fill(0, p, p + ROW.size);
      this.mod.setValue(p + ROW.fields.has_method.offset, row.method === null ? 0 : 1, "i32");
      this.mod.setValue(p + ROW.fields.method.offset, row.method ?? 0, "i32");
      params.forEach((v, k) => this.mod.setValue(p + ROW.fields.p.offset + 8 * k, v, "double"));
      this.mod.setValue(p + ROW.fields.dest.offset, row.dest ?? SurfaceInfilDest.LOST, "i32");
      raiseForCode(call(p));
    });
  }
}
