/**
 * @file types.ts
 * @brief TypeScript type declarations for the Emscripten-generated WASM module.
 *
 * @details Declares the shape of the object returned by `createOpenSwmmModule()`
 * so that `Solver` and the domain collection classes can call into the WASM
 * engine with full type safety.
 *
 * These types are structural (duck-typed) interfaces — the actual object is
 * produced at runtime by the Emscripten glue code.
 *
 * @author   Caleb Buahin <caleb.buahin@gmail.com>
 * @copyright Copyright (c) 2026 Caleb Buahin. All rights reserved.
 * @license  MIT
 */

// =============================================================================
// Emscripten Module interface
// =============================================================================

/**
 * Low-level Emscripten filesystem API exposed for .inp/.rpt/.out file I/O.
 */
export interface EmscriptenFS {
  mkdir(path: string): void;
  writeFile(path: string, data: Uint8Array | string): void;
  readFile(path: string, opts?: { encoding: "binary" }): Uint8Array;
  readFile(path: string, opts: { encoding: "utf8" }): string;
  unlink(path: string): void;
}

/**
 * The Emscripten module object returned by `createOpenSwmmModule()`.
 *
 * Only the runtime surface used by the binding layer is declared. The C API
 * itself is reached through the generated raw layer (`raw.ts`, `rawOf(mod)`),
 * whose exports live on this object as `_swmm_*` members.
 */
export interface OpenSwmmWasmModule {
  /** Emscripten virtual filesystem. */
  readonly FS: EmscriptenFS;

  // ---- heap ---------------------------------------------------------------
  _malloc(size: number): number;
  _free(ptr: number): void;
  getValue(ptr: number, type: string): number;
  setValue(ptr: number, value: number, type: string): void;
  readonly HEAP8: Int8Array;
  readonly HEAPU8: Uint8Array;
  readonly HEAP32: Int32Array;
  readonly HEAPU32: Uint32Array;
  readonly HEAPF32: Float32Array;
  readonly HEAPF64: Float64Array;

  // ---- strings ------------------------------------------------------------
  UTF8ToString(ptr: number, maxBytes?: number): string;
  stringToUTF8(str: string, outPtr: number, maxBytesToWrite: number): void;
  lengthBytesUTF8(str: string): number;

  // ---- calls / callbacks --------------------------------------------------
  cwrap(name: string, ret: string | null, args: string[]): (...a: unknown[]) => unknown;
  /** Turn a JS function into a C function pointer (`-sALLOW_TABLE_GROWTH`). */
  addFunction(fn: (...args: number[]) => number | void, signature: string): number;
  removeFunction(ptr: number): void;

  /** Raw C exports (`_swmm_*`, `_malloc`, ...). */
  [exportName: `_${string}`]: unknown;
}

// =============================================================================
// OADate helpers
// =============================================================================

/**
 * OADate epoch: 30 December 1899 00:00:00 UTC.
 *
 * The engine stores all timestamps as OA (OLE Automation) dates — decimal
 * days since this epoch. Values before 1 March 1900 require a special
 * correction because the original Lotus 1-2-3 / Excel bug treated 1900 as a
 * leap year; the engine already corrects for this, so we handle it too.
 */
const OA_EPOCH_MS = Date.UTC(1899, 11, 30); // 30 Dec 1899

/**
 * Convert an OADate (decimal days since 30 Dec 1899) to a JavaScript `Date`.
 *
 * @param oadate OADate value from the engine.
 */
export function oadateToDate(oadate: number): Date {
  return new Date(OA_EPOCH_MS + oadate * 86400000);
}

/**
 * Convert a JavaScript `Date` to an OADate.
 *
 * @param date JavaScript `Date` object.
 */
export function dateToOadate(date: Date): number {
  return (date.getTime() - OA_EPOCH_MS) / 86400000;
}
