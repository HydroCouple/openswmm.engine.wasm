/**
 * @file datetime.ts
 * @brief SWMM DateTime arithmetic through the engine (Python `openswmm.engine._datetime`).
 *
 * A SWMM DateTime is a `number` of days since 1899-12-30: the integer part is
 * the date, the fraction the time of day (0.5 = noon). These functions call the
 * engine's `openswmm_datetime.h`, so results match a legacy SWMM run bit for
 * bit. Python binds them to its one native library; here the WASM module
 * instance is the first argument.
 *
 * @license  Apache-2.0
 */

import { BadParamError } from "./errors.js";
import { checkedAlloc, rawOf } from "./mem.js";
import type { OpenSwmmWasmModule } from "./types.js";

/** Call `fill(out)` with `n` int32 out-slots and return their values. */
function withInts(mod: OpenSwmmWasmModule, n: number, fill: (out: number) => number): number[] {
  const out = checkedAlloc(mod, 4 * n);
  try {
    mod.HEAP32.fill(0, out >> 2, (out >> 2) + n);
    fill(out);
    return Array.from(mod.HEAP32.subarray(out >> 2, (out >> 2) + n));
  } finally {
    mod._free(out);
  }
}

/** Call `fill(out)` with one double out-slot; `rc !== 0` throws `BadParamError(message)`. */
function withDoubleOut(
  mod: OpenSwmmWasmModule,
  fill: (out: number) => number,
  message: () => string,
): number {
  const out = checkedAlloc(mod, 8);
  try {
    mod.HEAPF64[out >> 3] = 0;
    if (fill(out) !== 0) throw new BadParamError(message());
    return mod.HEAPF64[out >> 3];
  } finally {
    mod._free(out);
  }
}

/**
 * Encode a calendar date as a SWMM DateTime (date portion only).
 *
 * @param year  Year in 1..9999.
 * @param month Month in 1..12.
 * @param day   Day of month, valid for the year and month.
 * @returns Integer-valued SWMM DateTime.
 * @throws BadParamError when the date is out of range.
 */
export function encodeDate(
  mod: OpenSwmmWasmModule,
  year: number,
  month: number,
  day: number,
): number {
  return withDoubleOut(
    mod,
    (out) => rawOf(mod).swmm_datetime_encode_date(year, month, day, out),
    () => `invalid SWMM date: year=${year} month=${month} day=${day}`,
  );
}

/**
 * Encode a wall-clock time as the fractional-day part of a SWMM DateTime.
 *
 * @returns Fraction of a day in [0, 1).
 * @throws BadParamError when a component is negative.
 */
export function encodeTime(
  mod: OpenSwmmWasmModule,
  hour: number,
  minute: number,
  second: number,
): number {
  return withDoubleOut(
    mod,
    (out) => rawOf(mod).swmm_datetime_encode_time(hour, minute, second, out),
    () => `invalid SWMM time: hour=${hour} minute=${minute} second=${second}`,
  );
}

/** Decode the date portion of a SWMM DateTime to `[year, month, day]`. */
export function decodeDate(mod: OpenSwmmWasmModule, value: number): [number, number, number] {
  const [y, m, d] = withInts(mod, 3, (out) =>
    rawOf(mod).swmm_datetime_decode_date(value, out, out + 4, out + 8),
  );
  return [y, m, d];
}

/**
 * Decode the time of day of a SWMM DateTime to `[hour, minute, second]`, in
 * whole seconds as the legacy engine rounds them (`floor(frac * 86400 + 0.5)`).
 */
export function decodeTime(mod: OpenSwmmWasmModule, value: number): [number, number, number] {
  const [h, m, s] = withInts(mod, 3, (out) =>
    rawOf(mod).swmm_datetime_decode_time(value, out, out + 4, out + 8),
  );
  return [h, m, s];
}

/**
 * Shift a SWMM DateTime by `seconds` (may be negative), through the legacy
 * decompose-and-recompose path so the result is bit-identical to a legacy run.
 */
export function addSeconds(mod: OpenSwmmWasmModule, value: number, seconds: number): number {
  return withDoubleOut(
    mod,
    (out) => rawOf(mod).swmm_datetime_add_seconds(value, seconds, out),
    () => "swmm_datetime_add_seconds failed",
  );
}

/**
 * `value1 - value2` in whole seconds, each time rounded first. The engine
 * returns a C `long`, 32 bits on wasm32: differences beyond about ±68 years
 * do not fit.
 */
export function timeDiff(mod: OpenSwmmWasmModule, value1: number, value2: number): number {
  return withInts(mod, 1, (out) => rawOf(mod).swmm_datetime_time_diff(value1, value2, out))[0];
}
