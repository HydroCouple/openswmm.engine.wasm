/**
 * @file ndarray.ts
 * @brief Shaped arrays and Python-style axis selectors for the result readers
 *        (`Output2DReader`, `Results`).
 *
 * Python returns numpy arrays; here a read returns an {@link NDArray}: a
 * row-major typed array plus its shape. A selection gives one key per axis,
 * like a numpy index tuple: an integer picks one entry and drops the axis, a
 * {@link Slice} keeps it, `null` keeps the whole axis and {@link ELLIPSIS}
 * stands for every axis not named.
 *
 * @license  Apache-2.0
 */

/** Numeric storage of a shaped array. */
export type NumericData = Int32Array | Float32Array | Float64Array | BigInt64Array;

/** A row-major array and its shape (`[]` for a single value). */
export interface NDArray<D extends NumericData | string[] = NumericData | string[]> {
  readonly shape: readonly number[];
  readonly data: D;
}

/** A Python slice: `start:stop:step`, any part omitted. */
export interface Slice {
  readonly start?: number | null;
  readonly stop?: number | null;
  readonly step?: number | null;
}

/** Build a {@link Slice} (Python `slice(start, stop, step)`). */
export function slice(start?: number | null, stop?: number | null, step?: number | null): Slice {
  return { start, stop, step };
}

/** Stands for the axes a selection leaves out (Python `...`). */
export const ELLIPSIS: unique symbol = Symbol("...");

/** One axis of a selection. */
export type AxisKey = number | Slice | null | undefined | typeof ELLIPSIS;

/** True for a {@link Slice} object. */
export function isSlice(key: unknown): key is Slice {
  return typeof key === "object" && key !== null && !Array.isArray(key);
}

/** Python `slice.indices(length)`: the resolved start, stop and step. */
export function sliceIndices(s: Slice, length: number): [number, number, number] {
  const step = s.step ?? 1;
  if (step === 0) throw new RangeError("slice step cannot be zero");
  const [lower, upper] = step < 0 ? [-1, length - 1] : [0, length];
  const clamp = (v: number | null | undefined, fallback: number) => {
    if (v === null || v === undefined) return fallback;
    return v < 0 ? Math.max(v + length, lower) : Math.min(v, upper);
  };
  return [clamp(s.start, step < 0 ? upper : lower), clamp(s.stop, step < 0 ? lower : upper), step];
}

/** Number of entries a resolved slice selects. */
export function sliceLength(start: number, stop: number, step: number): number {
  return Math.max(0, Math.ceil((stop - start) / step));
}

/** Python `range(*slice.indices(length))`. */
export function sliceRange(s: Slice, length: number): number[] {
  const [start, stop, step] = sliceIndices(s, length);
  return Array.from({ length: sliceLength(start, stop, step) }, (_, i) => start + i * step);
}

/**
 * Expand a selection to one key per axis (Python `_selection_axes`): a single
 * key applies to axis zero, {@link ELLIPSIS} fills the axes not named and the
 * remaining axes are kept whole.
 */
export function selectionAxes<K>(selection: K | readonly K[], rank: number): (K | null)[] {
  let keys: (K | null)[] = Array.isArray(selection) ? [...(selection as K[])] : [selection as K];
  const ellipses = keys.filter((k) => k === ELLIPSIS).length;
  if (ellipses > 1) throw new RangeError("Only one ellipsis is allowed");
  if (ellipses) {
    const at = keys.indexOf(ELLIPSIS as K);
    keys = [
      ...keys.slice(0, at),
      ...Array<null>(rank - keys.length + 1).fill(null),
      ...keys.slice(at + 1),
    ];
  }
  if (keys.length > rank) throw new RangeError("Too many selection axes");
  return [...keys, ...Array<null>(rank - keys.length).fill(null)];
}

function allocLike<D extends NumericData | string[]>(like: D, n: number): D {
  if (Array.isArray(like)) return new Array<string>(n) as D;
  const Ctor = like.constructor as new (n: number) => D;
  return new Ctor(n);
}

function strides(shape: readonly number[]): number[] {
  const out = new Array<number>(shape.length);
  let s = 1;
  for (let i = shape.length - 1; i >= 0; i--) {
    out[i] = s;
    s *= shape[i];
  }
  return out;
}

/** Reverse the given axes (numpy `flip`). */
export function flip<D extends NumericData | string[]>(
  a: NDArray<D>,
  axes: readonly number[],
): NDArray<D> {
  if (!axes.length) return a;
  const { shape } = a;
  const st = strides(shape);
  const n = a.data.length;
  const out = allocLike(a.data, n);
  const src = a.data as ArrayLike<unknown>;
  const dst = out as unknown as { [i: number]: unknown };
  for (let i = 0; i < n; i++) {
    let rem = i;
    let from = 0;
    for (let ax = 0; ax < shape.length; ax++) {
      const idx = Math.floor(rem / st[ax]);
      rem -= idx * st[ax];
      from += (axes.includes(ax) ? shape[ax] - 1 - idx : idx) * st[ax];
    }
    dst[i] = src[from];
  }
  return { shape, data: out };
}

/** Join equal-shaped arrays along a new axis (numpy `stack`). */
export function stack<D extends NumericData | string[]>(
  chunks: readonly NDArray<D>[],
  axis: number,
): NDArray<D> {
  const inner = chunks[0].shape;
  const outer = inner.slice(0, axis).reduce((p, v) => p * v, 1);
  const block = inner.slice(axis).reduce((p, v) => p * v, 1);
  const out = allocLike(chunks[0].data, outer * block * chunks.length);
  const dst = out as unknown as { [i: number]: unknown };
  let w = 0;
  for (let o = 0; o < outer; o++) {
    for (const c of chunks) {
      const src = c.data as ArrayLike<unknown>;
      for (let b = 0; b < block; b++) dst[w++] = src[o * block + b];
    }
  }
  return { shape: [...inner.slice(0, axis), chunks.length, ...inner.slice(axis)], data: out };
}
