/**
 * @file dates.ts
 * @brief SWMM DateTime <-> `Date` conversion (Python `openswmm.engine._dates`).
 *
 * A SWMM DateTime counts days from 1899-12-30: the date is the floor of the
 * value and the time of day its fractional remainder, also for values before
 * the epoch. SWMM dates are UTC wall-clock times with no time zone or daylight
 * saving, so `Date` values are built and read in UTC. Times are rounded to the
 * millisecond (Python keeps microseconds; `Date` cannot).
 *
 * @license  Apache-2.0
 */

import { MS_PER_DAY } from "./units.js";

const OA_EPOCH_MS = Date.UTC(1899, 11, 30);

/** Convert a SWMM DateTime to a `Date` (UTC wall clock). */
export function oadateToDatetime(value: number): Date {
  const day = Math.floor(value);
  // Clamp so rounding just below midnight cannot roll into the next day.
  const ms = Math.min(Math.round((value - day) * MS_PER_DAY), MS_PER_DAY - 1);
  return new Date(OA_EPOCH_MS + day * MS_PER_DAY + ms);
}

/** Convert a `Date` (read as UTC wall clock) to a SWMM DateTime. */
export function datetimeToOadate(date: Date): number {
  const ms = date.getTime() - OA_EPOCH_MS;
  const day = Math.floor(ms / MS_PER_DAY);
  return day + (ms - day * MS_PER_DAY) / MS_PER_DAY;
}
