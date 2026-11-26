/**
 * @file Output2D.ts
 * @brief `Output2DReader`: read a closed 2D HDF5 result file independently of
 *        a solver (Python `openswmm.engine._output2d`).
 *
 * Paths name files in the module's file system (MEMFS by default). Numeric
 * datasets read as float64 (`Float64Array`) or int64 (`BigInt64Array`);
 * string tables read as `string[]`. Selections follow numpy indexing in the
 * native dimension order (see {@link NDArray}).
 *
 * @license  Apache-2.0
 */

import { ErrorCode } from "./enums.js";
import { FileError, StaleObjectError, raiseForCode } from "./errors.js";
import { checkedAlloc, rawOf } from "./mem.js";
import {
  type AxisKey,
  type NDArray,
  ELLIPSIS,
  flip,
  isSlice,
  selectionAxes,
  sliceIndices,
  sliceLength,
} from "./ndarray.js";
import type { RawApi } from "./raw.js";
import type { OpenSwmmWasmModule } from "./types.js";

/** Element type of a dataset (Python `numpy.dtype`). */
export type Output2DDType = "float64" | "int64" | "str";

/** A selection: one {@link AxisKey} for axis zero, or one per axis. */
export type Output2DSelection = AxisKey | readonly AxisKey[];

interface AxisRead {
  start: number;
  count: number;
  stride: number;
}

/** Python `str.splitlines()`. */
function lines(text: string): string[] {
  const out = text.split(/\r\n|\n|\r/);
  if (out[out.length - 1] === "") out.pop();
  return out;
}

/** Resolve numpy-style keys into native start/count/stride per axis. */
function resolveAxes(
  selection: Output2DSelection | undefined,
  shape: readonly number[],
): { axes: AxisRead[]; kept: number[]; reversed: number[] } {
  const keys = selection === undefined || selection === null ? [] : selection;
  const full = selectionAxes<AxisKey>(keys as AxisKey | readonly AxisKey[], shape.length);
  const axes: AxisRead[] = [];
  const kept: number[] = [];
  const reversed: number[] = [];
  full.forEach((key, i) => {
    const length = shape[i];
    if (key === null || key === undefined || isSlice(key)) {
      const [lo, hi, step] = sliceIndices(key ?? {}, length);
      const n = sliceLength(lo, hi, step);
      if (step < 0) {
        reversed.push(kept.length);
        axes.push({ start: n ? lo + (n - 1) * step : 0, count: n, stride: -step });
      } else {
        axes.push({ start: lo, count: n, stride: step });
      }
      kept.push(n);
    } else if (typeof key === "number" && Number.isInteger(key)) {
      const lo = key < 0 ? key + length : key;
      if (lo < 0 || lo >= length) throw new RangeError("Result index out of range");
      axes.push({ start: lo, count: 1, stride: 1 });
    } else if (key === ELLIPSIS) {
      throw new RangeError("Only one ellipsis is allowed");
    } else {
      throw new TypeError("A selection axis is an integer, a slice or null");
    }
  });
  return { axes, kept, reversed };
}

/** Read a closed 2D result file or an immutable copy of one. */
export class Output2DReader {
  private readonly _raw: RawApi;
  private _handle = 0;
  /** The path the reader was opened with. */
  readonly path: string;

  /**
   * Open a 2D result file.
   *
   * @throws {@link FileError} if the file cannot be opened.
   */
  constructor(
    private readonly _mod: OpenSwmmWasmModule,
    path: string,
  ) {
    this._raw = rawOf(_mod);
    this.path = path;
    if (path.includes("\0")) throw new RangeError("Embedded NUL in output path");
    const out = checkedAlloc(_mod, 4);
    try {
      _mod.HEAPU32[out >> 2] = 0;
      const status = this._raw.swmm_output2d_open(path, out);
      this._handle = _mod.HEAPU32[out >> 2];
      if (status === ErrorCode.IO || status === ErrorCode.BADINDEX) {
        throw new FileError(ErrorCode.OUTFILE, this._raw.swmm_output2d_error());
      }
      this._check(status);
    } finally {
      _mod._free(out);
    }
  }

  /** Whether the module was built with the HDF5 results reader. */
  static available(mod: OpenSwmmWasmModule): boolean {
    return rawOf(mod).swmm_output2d_available() !== 0;
  }

  /** Release the file. Repeated calls are harmless. */
  close(): void {
    this._raw.swmm_output2d_close(this._handle);
    this._handle = 0;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  /** @internal */
  private get _h(): number {
    if (!this._handle) throw new StaleObjectError("Output2DReader is closed");
    return this._handle;
  }

  /** @internal */
  private _check(status: number): void {
    if (status) raiseForCode(status, this._raw.swmm_output2d_error());
  }

  /** @internal Call a (text, capacity, size_t* required) getter: size, then copy. */
  private _text(call: (h: number, text: number, capacity: number, required: number) => number) {
    const mod = this._mod;
    const h = this._h;
    const req = checkedAlloc(mod, 4);
    try {
      mod.HEAPU32[req >> 2] = 0;
      this._check(call(h, 0, 0, req));
      const n = mod.HEAPU32[req >> 2];
      const buf = checkedAlloc(mod, Math.max(n, 1));
      try {
        this._check(call(h, buf, n, req));
        return mod.UTF8ToString(buf, n);
      } finally {
        mod._free(buf);
      }
    } finally {
      mod._free(req);
    }
  }

  /** Absolute paths of the numeric and string datasets, diagnostic groups included. */
  get datasets(): string[] {
    return lines(this._text((h, t, c, r) => this._raw.swmm_output2d_datasets(h, t, c, r)));
  }

  /** Attributes of a group or dataset. Numeric attributes are given as text. */
  attributes(path = "/"): Record<string, string> {
    const names = lines(
      this._text((h, t, c, r) => this._raw.swmm_output2d_attributes(h, path, t, c, r)),
    );
    const out: Record<string, string> = {};
    for (const name of names) {
      out[name] = this._text((h, t, c, r) =>
        this._raw.swmm_output2d_attribute(h, path, name, t, c, r),
      );
    }
    return out;
  }

  /** @internal */
  private _describe(path: string): [number[], Output2DDType, number[]] {
    const mod = this._mod;
    const p = checkedAlloc(mod, 8 + 8 * 8 + 8);
    try {
      const rank = p;
      const integer = p + 4;
      const dims = p + 8;
      const unlimited = p + 8 + 64;
      mod.HEAP32[rank >> 2] = 0;
      mod.HEAP32[integer >> 2] = 0;
      new BigUint64Array(mod.HEAPU8.buffer, unlimited, 1)[0] = 0n;
      this._check(this._raw.swmm_output2d_shape(this._h, path, rank, dims, integer, unlimited));
      const r = mod.HEAP32[rank >> 2];
      const d = new BigUint64Array(mod.HEAPU8.buffer, dims, r);
      const mask = new BigUint64Array(mod.HEAPU8.buffer, unlimited, 1)[0];
      const kind = mod.HEAP32[integer >> 2];
      const shape = Array.from(d, Number);
      const axes = shape.map((_, i) => i).filter((i) => (mask >> BigInt(i)) & 1n);
      return [shape, kind === -1 ? "str" : kind ? "int64" : "float64", axes];
    } finally {
      mod._free(p);
    }
  }

  /** The dataset's shape and read type (float64, int64 or str). */
  shape(path: string): [number[], Output2DDType] {
    const [shape, dtype] = this._describe(path);
    return [shape, dtype];
  }

  /** Indices of the dataset's appendable axes, as declared in the file. */
  unlimitedAxes(path: string): number[] {
    return this._describe(path)[2];
  }

  /** A small string identity table, in its native order. */
  strings(path: string): string[] {
    return this._text((h, t, c, r) => this._raw.swmm_output2d_strings(h, path, t, c, r))
      .split("\n")
      .slice(0, -1);
  }

  /**
   * Read a bounded selection. Integer keys remove their axis from the result;
   * negative slice steps reverse the read. Arrays are copies and stay usable
   * after {@link close}.
   */
  read(path: string, selection?: Output2DSelection): NDArray {
    const mod = this._mod;
    const [shape, dtype] = this.shape(path);
    if (dtype === "str") {
      const values = this.strings(path);
      if (selection === undefined || selection === null) {
        return { shape: [values.length], data: values };
      }
      const { axes, kept, reversed } = resolveAxes(selection, [values.length]);
      const { start, count, stride } = axes[0];
      const data = Array.from({ length: count }, (_, i) => values[start + i * stride]);
      return flip({ shape: kept, data }, reversed);
    }
    const { axes, kept, reversed } = resolveAxes(selection, shape);
    const rank = shape.length;
    const total = axes.reduce((p, a) => p * a.count, 1);
    const sel = checkedAlloc(mod, Math.max(24 * rank, 8));
    const values = checkedAlloc(mod, Math.max(8 * total, 8));
    try {
      const u64 = new BigUint64Array(mod.HEAPU8.buffer, sel, 3 * rank);
      axes.forEach((a, i) => {
        u64[i] = BigInt(a.start);
        u64[rank + i] = BigInt(a.count);
        u64[2 * rank + i] = BigInt(a.stride);
      });
      const [start, count, stride] = [sel, sel + 8 * rank, sel + 16 * rank];
      let data: Float64Array | BigInt64Array;
      if (dtype === "int64") {
        this._check(
          this._raw.swmm_output2d_read_int64(this._h, path, start, count, stride, values, total),
        );
        data = new BigInt64Array(mod.HEAPU8.buffer, values, total).slice();
      } else {
        this._check(
          this._raw.swmm_output2d_read_double(this._h, path, start, count, stride, values, total),
        );
        data = new Float64Array(mod.HEAPU8.buffer, values, total).slice();
      }
      return flip({ shape: kept, data }, reversed);
    } finally {
      mod._free(sel);
      mod._free(values);
    }
  }
}
