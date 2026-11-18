/**
 * @file Results.ts
 * @brief Discoverable, lazy result fields over the 1D and 2D readers (Python
 *        `openswmm.engine._results`).
 *
 * `Results` owns an {@link OutputReader} (binary `.out`), an
 * {@link Output2DReader} (2D HDF5 results) or both. Fields describe a recorded
 * variable (name, units, named dimensions, shape, times) and load values only
 * when read. Python's attribute shortcuts (`results.nodes.depth`,
 * `surface.depth`) are the `variables` maps here:
 * `results.nodes.variables.get("depth")`.
 *
 * @license  Apache-2.0
 */

import { FlowUnits, OutLinkVar, OutNodeVar, OutSubcatchVar, OutSystemVar } from "./enums.js";
import { BadIndexError, ElementNotFoundError } from "./errors.js";
import {
  type AxisKey,
  type NDArray,
  type Slice,
  ELLIPSIS,
  isSlice,
  selectionAxes,
  slice,
  sliceRange,
  stack,
} from "./ndarray.js";
import { Output2DReader } from "./Output2D.js";
import { OutputReader } from "./OutputReader.js";
import type { OpenSwmmWasmModule } from "./types.js";

/** Entries of one axis: all (`null`), a slice, one index or id, or a list of them. */
export type Selector = null | undefined | Slice | number | string | readonly (number | string)[];

/** A selection: axis zero's {@link Selector}, or one per axis (with {@link ELLIPSIS}). */
export type ResultSelection = Selector | readonly (Selector | typeof ELLIPSIS)[];

/** Named selectors of {@link ResultField.read}; `selection` excludes the others. */
export interface ResultReadOptions {
  periods?: Selector;
  objects?: Selector;
  species?: string | number | null;
  selection?: ResultSelection;
}

/** Python `_indices`: resolve a selector without allocating the whole axis. */
function indices(
  selection: Selector,
  size: number,
  names: readonly string[] = [],
): [number[], boolean] {
  if (selection === null || selection === undefined) return [sliceRange({}, size), false];
  if (Array.isArray(selection)) {
    return [
      (selection as (number | string)[]).map((key) => indices(key, size, names)[0][0]),
      false,
    ];
  }
  if (isSlice(selection)) return [sliceRange(selection, size), false];
  if (typeof selection === "string") {
    const index = names.indexOf(selection);
    if (index < 0) throw new ElementNotFoundError(selection);
    return [[index], true];
  }
  if (typeof selection !== "number" || !Number.isInteger(selection)) {
    throw new TypeError("A result selector is an index, an id, a slice or a list");
  }
  const index = selection < 0 ? selection + size : selection;
  if (index < 0 || index >= size) throw new RangeError("Result index out of range");
  return [[index], true];
}

const isFull = (key: unknown) => key === null || key === undefined || isSlice(key);

/** A lazy numeric field: inspect its metadata, then call {@link read}. */
export abstract class ResultField {
  abstract readonly name: string;
  abstract readonly units: string | null;
  abstract readonly dimensions: readonly string[];
  abstract get shape(): number[];
  /** Report times of the time axis, or `null` without one. */
  abstract get times(): Date[] | null;
  /** Load values; arrays are copies that stay valid after close. */
  abstract read(options?: ResultReadOptions): NDArray;

  /** Python `field[selection]`. */
  get(selection: ResultSelection): NDArray {
    return this.read({ selection });
  }
}

type SeriesKind = "node" | "link" | "subcatchment" | "system";

const FLOW_UNIT_LABELS: Record<string, string> = {
  CFS: "ft3/s",
  GPM: "gal/min",
  MGD: "million gal/day",
  CMS: "m3/s",
  LPS: "L/s",
  MLD: "million L/day",
};

/** Units of a recorded 1D variable (Python `_units`). */
function seriesUnits(reader: OutputReader, name: string): string | null {
  const flow = reader.flowUnits;
  const si = flow >= FlowUnits.CMS;
  const [length, rain] = si ? ["m", "mm"] : ["ft", "in"];
  if (name === "evap" || name === "pet") return `${rain}/day`;
  if (name === "rainfall" || name === "infil") return `${rain}/h`;
  if (name === "snow_depth") return rain;
  if (name === "depth" || name === "head" || name === "gw_elev") return length;
  if (name === "volume" || name === "storage") return `${length}3`;
  if (name === "velocity") return `${length}/s`;
  if (["capacity", "soil_moist", "snow_albedo", "snow_cover"].includes(name)) return "1";
  if (name === "temperature") return si ? "degC" : "degF";
  if (name === "snow_surface_temp" || name === "snow_bulk_temp") return "degC";
  if (name === "snow_energy") return "kJ/m2";
  if (name === "snow_swe") return "m";
  if (["snow_melt", "snow_input", "snow_sublimation"].includes(name)) return "m/s";
  if (name === "snow_time") return "s";
  return FLOW_UNIT_LABELS[FlowUnits[flow]];
}

/** One recorded 1D variable, optionally bound to one object. */
export class SeriesField extends ResultField {
  readonly dimensions: readonly string[];

  /** @internal */
  constructor(
    private readonly _collection: ResultCollection,
    readonly name: string,
    /** @internal */ readonly _code: number,
    readonly units: string | null,
    private readonly _objectIndex: number | null = null,
  ) {
    super();
    this.dimensions =
      _objectIndex !== null || _collection.kind === "system" ? ["time"] : ["time", "object"];
  }

  get shape(): number[] {
    const size = this._collection.reader.periodCount;
    return this.dimensions.length === 1 ? [size] : [size, this._collection.length];
  }

  get times(): Date[] {
    return this._collection.reader.periodTimes;
  }

  /** Ids along the object axis. */
  get objectIds(): string[] {
    return [...this._collection.ids];
  }

  read({ periods, objects, species, selection }: ResultReadOptions = {}): NDArray<Float32Array> {
    if (species !== undefined && species !== null) {
      throw new RangeError("Select a named species through the species mapping first");
    }
    if (selection !== undefined && selection !== null) {
      if (periods != null || objects != null) {
        throw new RangeError("Use selection or named selectors, not both");
      }
      const keys = selectionAxes(selection as Selector, this.dimensions.length) as Selector[];
      periods = keys[0];
      objects = keys.length > 1 ? keys[1] : null;
    }
    const collection = this._collection;
    const [times, scalarTime] = indices(periods, collection.reader.periodCount);
    const scalarField = this.dimensions.length === 1;
    if (objects !== null && objects !== undefined && scalarField) {
      throw new RangeError("This field is already bound to one object or the system");
    }
    const [objectIndices, scalarObject] = scalarField
      ? [[this._objectIndex ?? -1], true]
      : indices(objects, collection.length, collection.ids);
    const rows = times.length;
    const cols = objectIndices.length;
    const values = new Float32Array(rows * cols);
    if (rows && cols) {
      let low = times[0];
      let high = times[0];
      for (const t of times) {
        low = Math.min(low, t);
        high = Math.max(high, t);
      }
      // Bulk snapshots read every object; small selections read object
      // histories and never load the other ids.
      if (!scalarField && (objects === null || objects === undefined)) {
        times.forEach((period, row) =>
          values.set(collection._result(period, this._code), row * cols),
        );
      } else {
        objectIndices.forEach((index, col) => {
          const series = collection._series(index, this._code, low, high);
          times.forEach((t, row) => (values[row * cols + col] = series[t - low]));
        });
      }
    }
    let shape = [rows, cols];
    if (scalarField || scalarObject) shape = [rows];
    if (scalarTime) shape = shape.slice(1);
    return { shape, data: values };
  }
}

/** One recorded object (Python `_ResultObject`). */
export class ResultObject {
  /** @internal */
  constructor(
    private readonly _collection: ResultCollection,
    private readonly _index: number,
  ) {}

  get id(): string {
    return this._collection.ids[this._index];
  }

  /** The collection's variables, bound to this object. */
  get variables(): ReadonlyMap<string, SeriesField> {
    return this._bind(this._collection.variables);
  }

  /** The collection's species, bound to this object. */
  get species(): ReadonlyMap<string, SeriesField> {
    return this._bind(this._collection.species);
  }

  /** @internal */
  private _bind(fields: ReadonlyMap<string, SeriesField>): ReadonlyMap<string, SeriesField> {
    return new Map(
      [...fields].map(([name, f]) => [
        name,
        new SeriesField(this._collection, f.name, f._code, f.units, this._index),
      ]),
    );
  }
}

/** Recorded objects of one kind and their variables; index by id or position. */
export class ResultCollection {
  readonly ids: readonly string[];
  readonly variables: ReadonlyMap<string, SeriesField>;
  readonly species: ReadonlyMap<string, SeriesField>;

  /** @internal */
  constructor(
    readonly reader: OutputReader,
    readonly kind: SeriesKind,
  ) {
    const codes = {
      node: OutNodeVar,
      link: OutLinkVar,
      subcatchment: OutSubcatchVar,
      system: OutSystemVar,
    }[kind] as unknown as Record<string, string | number>;
    this.ids =
      kind === "node"
        ? reader.nodeIds
        : kind === "link"
          ? reader.linkIds
          : kind === "subcatchment"
            ? reader.subcatchmentIds
            : [];
    const fields = new Map<string, SeriesField>();
    const seen = new Set<number>();
    for (const [key, code] of Object.entries(codes)) {
      // Enum members in declaration order; aliases (a repeated code) are skipped.
      if (typeof code !== "number" || seen.has(code)) continue;
      seen.add(code);
      if (key === "POLLUT_BASE") continue;
      if (kind === "subcatchment" && !reader.hasSubcatchVariable(code)) continue;
      const name = key.toLowerCase();
      fields.set(name, new SeriesField(this, name, code, seriesUnits(reader, name)));
    }
    this.variables = fields;
    const base = codes.POLLUT_BASE as number | undefined;
    const species = new Map<string, SeriesField>();
    if (kind !== "system" && base !== undefined) {
      const units = reader.pollutantUnits;
      reader.pollutantIds.forEach((name, i) =>
        species.set(name, new SeriesField(this, name, base + i, units[i])),
      );
    }
    this.species = species;
  }

  get length(): number {
    return this.ids.length;
  }

  [Symbol.iterator](): Iterator<string> {
    return this.ids[Symbol.iterator]();
  }

  /** One object by id or index. */
  get(key: number | string): ResultObject {
    const [found, scalar] = indices(key, this.ids.length, this.ids);
    if (!scalar) throw new TypeError("Select one object by name or index");
    return new ResultObject(this, found[0]);
  }

  /** @internal Every object's value at one period. */
  _result(period: number, code: number): Float32Array {
    const r = this.reader;
    if (this.kind === "node") return r.nodeResult(period, code);
    if (this.kind === "link") return r.linkResult(period, code);
    if (this.kind === "subcatchment") return r.subcatchmentResult(period, code);
    return Float32Array.of(r.systemResult(period, code));
  }

  /** @internal One object's history over an inclusive period range. */
  _series(index: number, code: number, start: number, end: number): Float32Array {
    const r = this.reader;
    const range = { start, end };
    if (this.kind === "node") return r.nodeSeries(index, code, range);
    if (this.kind === "link") return r.linkSeries(index, code, range);
    if (this.kind === "subcatchment") return r.subcatchmentSeries(index, code, range);
    return r.systemSeries(code, range);
  }
}

/** Stored mesh: vertices (x, y, z rows) and cells in native order, padded with -1. */
export interface ResultMesh {
  vertices: NDArray<Float64Array>;
  cells: NDArray<Int32Array>;
  vertexCounts: Int32Array;
  crs: string | null;
  metresPerModelUnit: number | null;
  coordinateUnits: string | null;
}

const slashes = (path: string) => (path.match(/\//g) ?? []).length;

/** Named axes of a stored 2D dataset (Python `_axis_names`). */
function axisNames(
  reader: Output2DReader,
  path: string,
  shape: readonly number[],
  attrs: Readonly<Record<string, string>>,
): string[] {
  const rank = shape.length;
  let names = Array.from({ length: rank }, (_, i) => `axis_${i}`);
  const layout = /\[([^\]]+)\]/.exec(attrs.layout ?? "");
  if (layout) {
    const tokens = layout[1].split(",").map((v) => v.trim().toLowerCase());
    if (tokens.length === rank) {
      const aliases: Record<string, string> = {
        face: "cell",
        nface: "cell",
        ntime: "time",
        nspecies: "species",
        node: "vertex",
        nnode: "vertex",
      };
      names = tokens.map((t) => aliases[t] ?? t);
    }
  }
  const timed = reader.unlimitedAxes(path).includes(0) && slashes(path) === 1;
  if (timed) names[0] = "time";
  if (attrs.location === "face" && !names.includes("cell") && rank) names[rank - 1] = "cell";
  if (path === "/Mesh2_edge_flux") names = ["time", "cell", "edge"];
  else if (path.startsWith("/Mesh2_node_") && timed && rank === 2) names = ["time", "vertex"];
  else if (path === "/Mesh2_face_nodes") names = ["cell", "corner"];
  else if (rank === 1 && path.startsWith("/Mesh2_face_")) names = ["cell"];
  else if (path.startsWith("/Mesh2_edge_") && rank === 2) names = ["cell", "edge"];
  if (rank >= 3 && "species_names" in attrs && !names.includes("species")) names[1] = "species";
  // Unknown diagnostics keep positional axes rather than inventing a clock.
  return names;
}

/** A stored 2D dataset with named axes and optionally a bound cell or species. */
export class SurfaceField extends ResultField {
  readonly name: string;
  readonly units: string | null;
  readonly dimensions: readonly string[];
  readonly attributes: Readonly<Record<string, string>>;
  readonly speciesNames: readonly string[];
  private readonly _axes: readonly string[];
  private readonly _fixed: Readonly<Record<string, number>>;

  /** @internal */
  constructor(
    private readonly _surface: SurfaceResults,
    readonly path: string,
    fixed: Readonly<Record<string, number>> = {},
  ) {
    super();
    this._fixed = { ...fixed };
    this.name = path.slice(path.lastIndexOf("/") + 1).replace(/^Mesh2_face_/, "");
    this.attributes = Object.freeze(_surface.reader.attributes(path));
    const [shape] = _surface.reader.shape(path);
    this._axes = axisNames(_surface.reader, path, shape, this.attributes);
    this.dimensions = this._axes.filter((axis) => !(axis in this._fixed));
    this.speciesNames = (this.attributes.species_names ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    let units: string | null = this.attributes.units ?? null;
    if ("species" in this._fixed) {
      const labels = (this.attributes.species_units ?? "").split(",");
      const index = this._fixed.species;
      units = index < labels.length && labels[index].trim() ? labels[index].trim() : null;
    }
    this.units = units;
  }

  get shape(): number[] {
    const [shape] = this._surface.reader.shape(this.path);
    return shape.filter((_, i) => !(this._axes[i] in this._fixed));
  }

  get times(): Date[] | null {
    if (!this.dimensions.includes("time")) return null;
    const times = this._surface.periodTimes;
    if (times.length !== this.shape[this.dimensions.indexOf("time")]) {
      throw new RangeError(
        `${this.path} has incomplete report rows; inspect it with selection explicitly`,
      );
    }
    return times;
  }

  /** A field with some axes fixed, e.g. `bind({ cell: 3 })`. */
  bind(axes: Readonly<Record<string, number>>): SurfaceField {
    const unknown = Object.keys(axes).filter((a) => !this._axes.includes(a));
    if (unknown.length) throw new RangeError(`Field has no axes: [${unknown.sort().join(", ")}]`);
    return new SurfaceField(this._surface, this.path, { ...this._fixed, ...axes });
  }

  read({ periods, objects, species, selection }: ResultReadOptions = {}): NDArray {
    const reader = this._surface.reader;
    const [shape] = reader.shape(this.path);
    const keys: (AxisKey | readonly (number | string)[] | string)[] = this._axes.map((axis) =>
      axis in this._fixed ? this._fixed[axis] : null,
    );
    if (selection !== undefined && selection !== null) {
      if (periods != null || objects != null || species != null) {
        throw new RangeError("Use selection or named selectors, not both");
      }
      const selected = selectionAxes(selection as Selector, this.dimensions.length);
      const free = this._axes.flatMap((axis, i) => (axis in this._fixed ? [] : [i]));
      free.forEach((axis, j) => (keys[axis] = selected[j] as Selector));
    }
    const named: [string, Selector][] = [
      ["time", periods],
      ["cell", objects],
      ["species", species],
    ];
    for (const [axis, given] of named) {
      if (given === null || given === undefined) continue;
      if (!this.dimensions.includes(axis))
        throw new RangeError(`Field has no unbound ${axis} axis`);
      let key = given;
      if (axis === "species" && typeof key === "string") {
        const index = this.speciesNames.indexOf(key);
        if (index < 0) throw new ElementNotFoundError(key);
        key = index;
      }
      keys[this._axes.indexOf(axis)] = key;
    }
    // Ordered or repeated cell lists read one bounded slab per cell.
    const cellAxis = this._axes.indexOf("cell");
    if (cellAxis >= 0 && Array.isArray(keys[cellAxis])) {
      const [cells] = indices(keys[cellAxis] as Selector, shape[cellAxis]);
      const outAxis = keys.slice(0, cellAxis).filter(isFull).length;
      if (cells.length) {
        const chunks = cells.map((cell) => {
          const slab = [...keys];
          slab[cellAxis] = cell;
          return reader.read(this.path, slab as AxisKey[]);
        });
        return stack(chunks, outAxis);
      }
      keys[cellAxis] = slice(0, 0);
    }
    return reader.read(this.path, keys as AxisKey[]);
  }
}

/** One mesh cell (Python `_SurfaceCell`). */
export class SurfaceCell {
  /** @internal */
  constructor(
    private readonly _surface: SurfaceResults,
    readonly index: number,
  ) {}

  /** Species concentration fields bound to this cell. */
  get species(): ReadonlyMap<string, SurfaceField> {
    return new Map(
      [...this._surface.species].map(([name, f]) => [name, f.bind({ cell: this.index })]),
    );
  }
}

/** The mesh cells, by native zero-based index (Python `_SurfaceCells`). */
export class SurfaceCells {
  /** @internal */
  constructor(private readonly _surface: SurfaceResults) {}

  get length(): number {
    return this._surface.reader.shape("/Mesh2_face_nodes")[0][0];
  }

  get(index: number): SurfaceCell {
    const [found, scalar] = indices(index, this.length);
    if (!scalar) throw new TypeError("Select one cell by its native zero-based index");
    return new SurfaceCell(this._surface, found[0]);
  }
}

/** Parse a CF reference date (`YYYY-MM-DD[ T]hh:mm[:ss[.f]]`) as UTC. */
function cfReference(text: string): number {
  const m =
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*$/.exec(
      text.trim(),
    );
  if (!m) throw new RangeError(`Unsupported time reference: '${text}'`);
  const [, y, mo, d, h = "0", mi = "0", s = "0", frac = ""] = m;
  const ms = frac ? Math.round(Number(`0.${frac}`) * 1000) : 0;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, ms);
}

/** Saved 2D results; every recorded dataset is reachable through {@link field}. */
export class SurfaceResults {
  readonly cells: SurfaceCells;
  private readonly _paths: ReadonlySet<string>;
  private readonly _fields = new Map<string, SurfaceField>();

  /** @internal */
  constructor(readonly reader: Output2DReader) {
    this.cells = new SurfaceCells(this);
    this._paths = new Set(reader.datasets);
  }

  /** Top-level datasets by short name (`Mesh2_face_` dropped), `/time` excluded. */
  get variables(): ReadonlyMap<string, SurfaceField> {
    return new Map(
      [...this._paths]
        .sort()
        .filter((p) => slashes(p) === 1 && p !== "/time")
        .map((p) => [p.slice(1).replace(/^Mesh2_face_/, ""), this.field(p)]),
    );
  }

  /** A dataset by full path, nested diagnostic groups included. */
  field(path: string): SurfaceField {
    const full = "/" + path.replace(/^\/+/, "");
    if (!this._paths.has(full)) {
      throw new ElementNotFoundError(full, `Variable was not recorded: ${full}`);
    }
    let field = this._fields.get(full);
    if (!field) {
      field = new SurfaceField(this, full);
      this._fields.set(full, field);
    }
    return field;
  }

  /** Report dates from the file's CF time units (millisecond precision). */
  get periodTimes(): Date[] {
    const values = this.reader.read("/time").data as Float64Array;
    const units = this.reader.attributes("/time").units ?? "";
    const m = /^(days|hours|minutes|seconds) since (.+)$/.exec(units);
    if (!m) throw new RangeError(`Unsupported or missing time units: '${units}'`);
    const scale = { days: 86400, hours: 3600, minutes: 60, seconds: 1 }[m[1]]!;
    if (!values.every(Number.isFinite)) throw new RangeError("Non-finite report dates in output");
    const base = cfReference(m[2]);
    return Array.from(
      values,
      (v) => new Date(base + Math.round(Math.round(v * scale * 1e6) / 1000)),
    );
  }

  /** The stored mesh in model coordinates, cells renumbered from zero. */
  get mesh(): ResultMesh {
    const r = this.reader;
    const [xs, ys, zs] = ["x", "y", "z"].map(
      (a) => r.read(`/Mesh2_node_${a}`).data as Float64Array,
    );
    const nv = xs.length;
    const vertices = new Float64Array(nv * 3);
    for (let i = 0; i < nv; i++) {
      vertices[3 * i] = xs[i];
      vertices[3 * i + 1] = ys[i];
      vertices[3 * i + 2] = zs[i];
    }
    const raw = r.read("/Mesh2_face_nodes");
    const attrs = r.attributes("/Mesh2_face_nodes");
    const fill = Number(attrs._FillValue ?? "-1");
    const startIndex = Number(attrs.start_index ?? "0");
    const [nc, corners] = raw.shape;
    const cells = Int32Array.from(raw.data as ArrayLike<number | bigint>, (v) => {
      const n = Number(v);
      return n !== fill && n >= 0 ? n - startIndex : -1;
    });
    let counts: Int32Array;
    if (this._paths.has("/Mesh2_face_nv")) {
      counts = Int32Array.from(r.read("/Mesh2_face_nv").data as ArrayLike<number | bigint>, (v) =>
        Number(v),
      );
      if (counts.some((c) => c < 3 || c > corners)) {
        throw new RangeError("Invalid mesh cell vertex counts");
      }
      for (let c = 0; c < nc; c++) {
        for (let j = counts[c]; j < corners; j++) cells[c * corners + j] = -1;
      }
    } else {
      counts = Int32Array.from({ length: nc }, (_, c) =>
        cells.subarray(c * corners, (c + 1) * corners).reduce((n, v) => n + (v >= 0 ? 1 : 0), 0),
      );
    }
    if (cells.some((v) => v >= nv)) throw new RangeError("Mesh connectivity exceeds vertex count");
    let crs: Record<string, string> = {};
    try {
      crs = r.attributes("/crs");
    } catch (err) {
      if (!(err instanceof BadIndexError)) throw err;
    }
    return {
      vertices: { shape: [nv, 3], data: vertices },
      cells: { shape: [nc, corners], data: cells },
      vertexCounts: counts,
      crs: crs.model_crs ?? null,
      metresPerModelUnit: "metres_per_model_unit" in crs ? Number(crs.metres_per_model_unit) : null,
      coordinateUnits: crs.units || r.attributes("/Mesh2_node_x").units || null,
    };
  }

  /** Species concentration fields, by species name. */
  get species(): ReadonlyMap<string, SurfaceField> {
    const path = "/Mesh2_face_species_conc";
    if (!this._paths.has(path)) return new Map();
    const field = this.field(path);
    return new Map(field.speciesNames.map((name, i) => [name, field.bind({ species: i })]));
  }

  /** The `/mass_balance_2d` totals, plus `continuity_error` when stored. */
  get massBalance(): ReadonlyMap<string, number> {
    const prefix = "/mass_balance_2d/";
    const result = new Map<string, number>(
      [...this._paths]
        .sort()
        .filter((p) => p.startsWith(prefix))
        .map((p) => [p.slice(prefix.length), Number(this.reader.read(p).data[0])]),
    );
    if (result.size) {
      const attrs = this.reader.attributes("/mass_balance_2d");
      if ("continuity_error" in attrs)
        result.set("continuity_error", Number(attrs.continuity_error));
    }
    return result;
  }
}

/**
 * Independent readers for a 1D output, a 2D output or both. Their reporting
 * clocks stay separate. 2D files must be closed (immutable); `live` applies
 * only to the binary 1D output. Close with {@link close} or `using`.
 */
export class Results {
  readonly output: OutputReader | null = null;
  readonly surface: SurfaceResults | null = null;
  readonly nodes?: ResultCollection;
  readonly links?: ResultCollection;
  readonly subcatchments?: ResultCollection;
  readonly system?: ResultCollection;
  private readonly _open: { close(): void }[] = [];

  constructor(
    mod: OpenSwmmWasmModule,
    path?: string | null,
    { surface, live = false }: { surface?: string | null; live?: boolean } = {},
  ) {
    if ((path === null || path === undefined) && (surface === null || surface === undefined)) {
      throw new RangeError("Provide a 1D output path, a 2D surface path, or both");
    }
    try {
      if (path !== null && path !== undefined) {
        const output = new OutputReader(mod, path, { live });
        this._open.push(output);
        this.output = output;
        this.nodes = new ResultCollection(output, "node");
        this.links = new ResultCollection(output, "link");
        this.subcatchments = new ResultCollection(output, "subcatchment");
        this.system = new ResultCollection(output, "system");
      }
      if (surface !== null && surface !== undefined) {
        const reader = new Output2DReader(mod, surface);
        this._open.push(reader);
        this.surface = new SurfaceResults(reader);
      }
    } catch (err) {
      this.close();
      throw err;
    }
  }

  /** Python `Results.open(path, surface=..., live=...)`. */
  static open(
    mod: OpenSwmmWasmModule,
    path?: string | null,
    options: { surface?: string | null; live?: boolean } = {},
  ): Results {
    return new Results(mod, path, options);
  }

  /** 1D report dates; the surface has its own `periodTimes`. */
  get times(): Date[] {
    if (!this.output) throw new RangeError("No 1D output was opened; use surface.periodTimes");
    return this.output.periodTimes;
  }

  /** Pick up completed 1D report periods (the 2D file is not tailed). */
  refresh(): number {
    if (!this.output) throw new RangeError("No 1D output was opened");
    return this.output.refresh();
  }

  /** Close every reader (last opened first). Repeated calls are harmless. */
  close(): void {
    while (this._open.length) this._open.pop()!.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
