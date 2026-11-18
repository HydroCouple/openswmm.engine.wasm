/**
 * @file element.ts
 * @brief Shared out-parameter helpers for the element views (nodes, links,
 *        subcatchments) and their sub-views.
 *
 * @license  Apache-2.0
 */

import { ElementNotFoundError, raiseForCode } from "./errors.js";
import {
  checkedAlloc,
  withCString,
  withCStrings,
  withDouble,
  withDoubleArray,
  withDoubleInput,
  withInt,
} from "./mem.js";
import type { RawApi } from "./raw.js";
import type { OpenSwmmWasmModule } from "./types.js";

/** A fresh (stale-checked) element: module, raw API, engine handle and index. */
export interface ElementCtx {
  readonly mod: OpenSwmmWasmModule;
  readonly raw: RawApi;
  readonly engine: number;
  readonly index: number;
}

/** `fn(engine, index, double*)` → the double. */
export function getDouble(
  c: ElementCtx,
  fn: (e: number, i: number, out: number) => number,
): number {
  return withDouble(c.mod, (p) => fn(c.engine, c.index, p));
}

/** `fn(engine, index, int*)` → the int. */
export function getInt(c: ElementCtx, fn: (e: number, i: number, out: number) => number): number {
  return withInt(c.mod, (p) => fn(c.engine, c.index, p));
}

/** `fn(engine, index, double* × n)` → the n doubles. */
export function getDoubles(
  c: ElementCtx,
  n: number,
  fn: (e: number, i: number, ...outs: number[]) => number,
): number[] {
  const p = checkedAlloc(c.mod, 8 * n);
  try {
    c.mod.HEAPF64.fill(0, p >> 3, (p >> 3) + n);
    raiseForCode(fn(c.engine, c.index, ...Array.from({ length: n }, (_, k) => p + 8 * k)));
    return Array.from(c.mod.HEAPF64.subarray(p >> 3, (p >> 3) + n));
  } finally {
    c.mod._free(p);
  }
}

/** `fn(engine, index, char* buf, int len)` → the string. */
export function getText(
  c: ElementCtx,
  fn: (e: number, i: number, buf: number, len: number) => number,
  size = 256,
): string {
  return withCString(c.mod, size, (buf, len) => fn(c.engine, c.index, buf, len));
}

/** A bulk `fn(double* buf, int n)` read of `n` values (n = 0 → empty, no call). */
export function bulkRead(
  mod: OpenSwmmWasmModule,
  n: number,
  fn: (buf: number, n: number) => number,
) {
  return n > 0 ? withDoubleArray(mod, n, (p) => fn(p, n)) : new Float64Array(0);
}

/** A bulk `fn(const double* buf, int n)` write; `values.length` must equal `n`. */
export function bulkWrite(
  mod: OpenSwmmWasmModule,
  n: number,
  values: ArrayLike<number>,
  what: string,
  fn: (buf: number, n: number) => number,
): void {
  if (values.length !== n)
    throw new RangeError(`${what} array length ${values.length} != count ${n}`);
  if (n > 0) withDoubleInput(mod, values, (p) => fn(p, n));
}

/** Index of an element kind's id (`swmm_<kind>_index`), or the index itself. */
export function resolveIndex(
  raw: RawApi,
  engine: number,
  kind: "node" | "link" | "subcatch" | "pollutant" | "gage" | "landuse" | "aquifer" | "snowpack",
  key: number | string,
): number {
  if (typeof key === "number") return key;
  const i = raw[`swmm_${kind}_index`](engine, key);
  if (i < 0) throw new ElementNotFoundError(key);
  return i;
}

/**
 * A buildup/washoff/loading constituent: a pollutant (index or id) or a
 * reaction species name, addressed after the pollutants (`np + m`) as the C
 * API does. Indices may run over pollutants and species.
 */
export function resolveSurfaceSpecies(
  mod: OpenSwmmWasmModule,
  raw: RawApi,
  engine: number,
  key: number | string,
): number {
  const np = raw.swmm_pollutant_count(engine);
  const nm = raw.swmm_reaction_species_count(engine);
  if (typeof key === "number") {
    if (!Number.isInteger(key) || key < 0 || key >= np + nm) {
      throw new ElementNotFoundError(
        key,
        `Pollutant/species index ${key} out of range [0, ${np + nm})`,
      );
    }
    return key;
  }
  const i = raw.swmm_pollutant_index(engine, key);
  if (i >= 0) return i;
  const scratch = checkedAlloc(mod, 24);
  try {
    for (let m = 0; m < nm; m++) {
      const [name] = withCStrings(mod, 256, 2, ([n, u], len) =>
        raw.swmm_reaction_species_get(
          engine,
          m,
          n,
          len,
          scratch,
          u,
          len,
          scratch + 8,
          scratch + 16,
        ),
      );
      if (name === key) return np + m;
    }
  } finally {
    mod._free(scratch);
  }
  throw new ElementNotFoundError(key, `Pollutant or species '${key}' not found`);
}
