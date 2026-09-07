/**
 * @file mem.ts
 * @brief Raw-layer access and WASM heap helpers shared by the wrapper classes.
 *
 * @author   Caleb Buahin <caleb.buahin@gmail.com>
 * @copyright Copyright (c) 2026 Caleb Buahin. All rights reserved.
 * @license  MIT
 */

import { bindRaw, type RawApi } from "./raw.js";
import type { OpenSwmmWasmModule } from "./types.js";
import { raiseForCode } from "./errors.js";

const rawCache = new WeakMap<OpenSwmmWasmModule, RawApi>();

/** The generated raw C-API table for `mod` (bound once per module instance). */
export function rawOf(mod: OpenSwmmWasmModule): RawApi {
  let raw = rawCache.get(mod);
  if (!raw) {
    raw = bindRaw(mod);
    rawCache.set(mod, raw);
  }
  return raw;
}

/**
 * Call a C function that fills a caller-provided `char* buf, int buflen` and
 * return the string. Throws the mapped `EngineError` on a non-zero code.
 */
export function withCString(
  mod: OpenSwmmWasmModule,
  size: number,
  call: (buf: number, len: number) => number,
): string {
  const buf = mod._malloc(size);
  try {
    raiseForCode(call(buf, size));
    return mod.UTF8ToString(buf, size);
  } finally {
    mod._free(buf);
  }
}

/** Call a C function with a `double*` out-parameter and return the value. */
export function withDouble(
  mod: OpenSwmmWasmModule,
  call: (ptr: number) => number,
): number {
  const ptr = mod._malloc(8);
  try {
    raiseForCode(call(ptr));
    return mod.getValue(ptr, "double");
  } finally {
    mod._free(ptr);
  }
}

/** Call a C function with an `int*` out-parameter and return the value. */
export function withInt(
  mod: OpenSwmmWasmModule,
  call: (ptr: number) => number,
): number {
  const ptr = mod._malloc(4);
  try {
    raiseForCode(call(ptr));
    return mod.getValue(ptr, "i32");
  } finally {
    mod._free(ptr);
  }
}

/**
 * Call a C bulk getter that fills `double* out` for `n` elements and return
 * a copy as `Float64Array` (the WASM heap may move on growth, so no views).
 */
export function withDoubleArray(
  mod: OpenSwmmWasmModule,
  n: number,
  call: (ptr: number) => number,
): Float64Array {
  if (n <= 0) return new Float64Array(0);
  const ptr = mod._malloc(8 * n);
  try {
    raiseForCode(call(ptr));
    return new Float64Array(mod.HEAPF64.buffer, ptr, n).slice();
  } finally {
    mod._free(ptr);
  }
}

/** Copy `values` into a temporary `double*` block, call, and free it. */
export function withDoubleInput(
  mod: OpenSwmmWasmModule,
  values: ArrayLike<number>,
  call: (ptr: number, n: number) => number,
): void {
  const n = values.length;
  const ptr = mod._malloc(8 * Math.max(n, 1));
  try {
    mod.HEAPF64.set(Array.from(values), ptr / 8);
    raiseForCode(call(ptr, n));
  } finally {
    mod._free(ptr);
  }
}
