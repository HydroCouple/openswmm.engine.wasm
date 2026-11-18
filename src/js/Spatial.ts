/**
 * @file Spatial.ts
 * @brief `solver.spatial`: coordinates, polylines, polygons, the `[MAP]`
 *        section and the coordinate reference system (Python
 *        `openswmm.engine._spatial`).
 *
 * Coordinate arrays are {@link NDArray}s of shape `[n, 2]` (x, y rows);
 * setters also take a list of `[x, y]` pairs.
 *
 * @license  Apache-2.0
 */

import { resolveIndex } from "./element.js";
import { raiseForCode } from "./errors.js";
import { checkedAlloc, withCString, withInt } from "./mem.js";
import type { NDArray } from "./ndarray.js";
import { SolverView } from "./view.js";

/** `[n, 2]` coordinates: an {@link NDArray} or a list of `[x, y]` pairs. */
export type XYArray = NDArray<Float64Array> | readonly (readonly [number, number])[];

/** Split `[n, 2]` coordinates into x and y columns. */
function columns(coords: XYArray, what: string): [Float64Array, Float64Array] {
  let n: number;
  let at: (i: number, c: number) => number;
  if (Array.isArray(coords)) {
    const rows = coords as readonly (readonly number[])[];
    if (rows.some((r) => r.length !== 2)) throw new RangeError(`${what} rows must be [x, y]`);
    n = rows.length;
    at = (i, c) => rows[i][c];
  } else {
    const a = coords as NDArray<Float64Array>;
    if (a.shape.length !== 2 || a.shape[1] !== 2) {
      throw new RangeError(`${what} must be shape (n, 2); got (${a.shape.join(", ")})`);
    }
    n = a.shape[0];
    at = (i, c) => a.data[2 * i + c];
  }
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = at(i, 0);
    ys[i] = at(i, 1);
  }
  return [xs, ys];
}

/** `solver.spatial`. */
export class Spatial extends SolverView {
  /** @internal */
  private _index(kind: "node" | "link" | "subcatch" | "gage", key: number | string): number {
    return resolveIndex(this._raw, this._h, kind, key);
  }

  /** @internal Call a getter with two `double*` outputs. */
  private _pair(fn: (x: number, y: number) => number): [number, number] {
    const mod = this._mod;
    const p = checkedAlloc(mod, 16);
    try {
      mod.HEAPF64[p >> 3] = 0;
      mod.HEAPF64[(p + 8) >> 3] = 0;
      raiseForCode(fn(p, p + 8));
      return [mod.HEAPF64[p >> 3], mod.HEAPF64[(p + 8) >> 3]];
    } finally {
      mod._free(p);
    }
  }

  /** @internal Read `n` points through `(x*, y*)` buffers. */
  private _points(n: number, fn: (x: number, y: number) => number): NDArray<Float64Array> {
    const mod = this._mod;
    const p = checkedAlloc(mod, Math.max(16 * n, 8));
    try {
      raiseForCode(fn(p, p + 8 * n));
      const xs = new Float64Array(mod.HEAPU8.buffer, p, n);
      const ys = new Float64Array(mod.HEAPU8.buffer, p + 8 * n, n);
      const data = new Float64Array(2 * n);
      for (let i = 0; i < n; i++) {
        data[2 * i] = xs[i];
        data[2 * i + 1] = ys[i];
      }
      return { shape: [n, 2], data };
    } finally {
      mod._free(p);
    }
  }

  /** @internal Pass x and y columns to a setter. */
  private _write(xs: Float64Array, ys: Float64Array, fn: (x: number, y: number) => number): void {
    const mod = this._mod;
    const n = xs.length;
    const p = checkedAlloc(mod, Math.max(16 * n, 8));
    try {
      mod.HEAPF64.set(xs, p >> 3);
      mod.HEAPF64.set(ys, (p >> 3) + n);
      raiseForCode(fn(p, p + 8 * n));
    } finally {
      mod._free(p);
    }
  }

  // ---- CRS, [MAP] and annotations ----------------------------------------------

  /**
   * Coordinate reference system (EPSG token, WKT or proj string); `""` when
   * the model has none (`solver.crs` throws `CRSError` instead).
   */
  get crs(): string {
    return withCString(this._mod, 256, (buf, len) =>
      this._raw.swmm_spatial_get_crs(this._h, buf, len),
    );
  }
  set crs(value: string) {
    raiseForCode(this._raw.swmm_spatial_set_crs(this._h, value));
  }

  /** `[MAP] DIMENSIONS` as `[x1, y1, x2, y2]`. */
  get mapDimensions(): [number, number, number, number] {
    const mod = this._mod;
    const p = checkedAlloc(mod, 32);
    try {
      mod.HEAPF64.fill(0, p >> 3, (p >> 3) + 4);
      raiseForCode(this._raw.swmm_spatial_get_map_dimensions(this._h, p, p + 8, p + 16, p + 24));
      const f = mod.HEAPF64;
      return [f[p >> 3], f[(p >> 3) + 1], f[(p >> 3) + 2], f[(p >> 3) + 3]];
    } finally {
      mod._free(p);
    }
  }
  set mapDimensions([x1, y1, x2, y2]: readonly [number, number, number, number]) {
    raiseForCode(this._raw.swmm_spatial_set_map_dimensions(this._h, x1, y1, x2, y2));
  }

  /** `[MAP] UNITS`, upper case (`""` when not stated). */
  get mapUnits(): string {
    const mod = this._mod;
    const buf = checkedAlloc(mod, 64);
    try {
      mod.HEAPU8[buf] = 0;
      raiseForCode(this._raw.swmm_spatial_get_map_units(this._h, buf, 64));
      return mod.UTF8ToString(buf, 64);
    } finally {
      mod._free(buf);
    }
  }
  set mapUnits(value: string) {
    raiseForCode(this._raw.swmm_spatial_set_map_units(this._h, value));
  }

  /**
   * Lines of `LABELS`, `BACKDROP`, `PROFILE` or `PROFILES`, verbatim and
   * joined by newlines (the engine never interprets them).
   */
  getAnnotation(section: string): string {
    const mod = this._mod;
    const required = withInt(mod, (p) =>
      this._raw.swmm_spatial_get_annotation(this._h, section, 0, 0, p),
    );
    const buf = checkedAlloc(mod, Math.max(required, 1));
    try {
      mod.HEAPU8[buf] = 0;
      raiseForCode(this._raw.swmm_spatial_get_annotation(this._h, section, buf, required, 0));
      return mod.UTF8ToString(buf, required);
    } finally {
      mod._free(buf);
    }
  }

  /** Replace an annotation section's lines; `""` or `null` removes it. */
  setAnnotation(section: string, text: string | null): void {
    raiseForCode(this._raw.swmm_spatial_set_annotation(this._h, section, text ?? ""));
  }

  // ---- nodes -------------------------------------------------------------------

  /** Whether coordinates were supplied, a valid origin (0, 0) included. */
  nodeHasCoord(node: number | string): boolean {
    const i = this._index("node", node);
    return withInt(this._mod, (p) => this._raw.swmm_spatial_node_has_coord(this._h, i, p)) !== 0;
  }

  nodeCoord(node: number | string): [number, number] {
    const i = this._index("node", node);
    return this._pair((x, y) => this._raw.swmm_spatial_get_node_coord(this._h, i, x, y));
  }

  setNodeCoord(node: number | string, x: number, y: number): void {
    const i = this._index("node", node);
    raiseForCode(this._raw.swmm_spatial_set_node_coord(this._h, i, x, y));
  }

  /** Every node's coordinates, shape `[nNodes, 2]`. */
  nodeCoords(): NDArray<Float64Array> {
    const h = this._h;
    const n = this._raw.swmm_node_count(h);
    // The C bulk calls refuse a zero count.
    if (n === 0) return { shape: [0, 2], data: new Float64Array(0) };
    return this._points(n, (x, y) => this._raw.swmm_spatial_get_node_coords_bulk(h, x, y, n));
  }

  /** Set every node's coordinates from `[nNodes, 2]` rows. */
  setNodeCoords(coords: XYArray): void {
    const h = this._h;
    const n = this._raw.swmm_node_count(h);
    const [xs, ys] = columns(coords, "node coords array");
    if (xs.length !== n) {
      throw new RangeError(`node coords array must have shape (${n}, 2), got (${xs.length}, 2)`);
    }
    if (n > 0)
      this._write(xs, ys, (x, y) => this._raw.swmm_spatial_set_node_coords_bulk(h, x, y, n));
  }

  // ---- links -------------------------------------------------------------------

  /** A link's mid-point coordinate. */
  linkCoord(link: number | string): [number, number] {
    const i = this._index("link", link);
    return this._pair((x, y) => this._raw.swmm_spatial_get_link_coord(this._h, i, x, y));
  }

  setLinkCoord(link: number | string, x: number, y: number): void {
    const i = this._index("link", link);
    raiseForCode(this._raw.swmm_spatial_set_link_coord(this._h, i, x, y));
  }

  /**
   * A link's full polyline, shape `[n, 2]`: the start node, the interior
   * vertices, then the end node.
   */
  linkVertices(link: number | string): NDArray<Float64Array> {
    const i = this._index("link", link);
    const h = this._h;
    const n = withInt(this._mod, (p) => this._raw.swmm_spatial_get_link_vertex_count(h, i, p));
    return this._points(n, (x, y) => this._raw.swmm_spatial_get_link_vertices(h, i, x, y, n));
  }

  /** Set a link's interior vertices (the end nodes are not included). */
  setLinkVertices(link: number | string, vertices: XYArray): void {
    const i = this._index("link", link);
    const h = this._h;
    const [xs, ys] = columns(vertices, "link vertices");
    this._write(xs, ys, (x, y) => this._raw.swmm_spatial_set_link_vertices(h, i, x, y, xs.length));
  }

  // ---- subcatchments -------------------------------------------------------------

  /** A subcatchment's centroid coordinate. */
  subcatchmentCoord(sub: number | string): [number, number] {
    const i = this._index("subcatch", sub);
    return this._pair((x, y) => this._raw.swmm_spatial_get_subcatch_coord(this._h, i, x, y));
  }

  setSubcatchmentCoord(sub: number | string, x: number, y: number): void {
    const i = this._index("subcatch", sub);
    raiseForCode(this._raw.swmm_spatial_set_subcatch_coord(this._h, i, x, y));
  }

  /**
   * Every boundary ring, concatenated, shape `[n, 2]`. Each ring is closed by
   * repeating its first vertex (the last may be open); even/odd containment
   * defines holes.
   */
  subcatchmentPolygon(sub: number | string): NDArray<Float64Array> {
    const i = this._index("subcatch", sub);
    const h = this._h;
    const n = withInt(this._mod, (p) => this._raw.swmm_spatial_get_subcatch_polygon_count(h, i, p));
    return this._points(n, (x, y) => this._raw.swmm_spatial_get_subcatch_polygon(h, i, x, y, n));
  }

  /** Set concatenated boundary rings (close each ring before the next). */
  setSubcatchmentPolygon(sub: number | string, polygon: XYArray): void {
    const i = this._index("subcatch", sub);
    const h = this._h;
    const [xs, ys] = columns(polygon, "polygon");
    this._write(xs, ys, (x, y) =>
      this._raw.swmm_spatial_set_subcatch_polygon(h, i, x, y, xs.length),
    );
  }

  // ---- gages -------------------------------------------------------------------

  gageCoord(gage: number | string): [number, number] {
    const i = this._index("gage", gage);
    return this._pair((x, y) => this._raw.swmm_spatial_get_gage_coord(this._h, i, x, y));
  }

  setGageCoord(gage: number | string, x: number, y: number): void {
    const i = this._index("gage", gage);
    raiseForCode(this._raw.swmm_spatial_set_gage_coord(this._h, i, x, y));
  }
}
