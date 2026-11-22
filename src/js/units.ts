/**
 * @file units.ts
 * @brief Time-unit constants the bindings share, defined once.
 *
 * SWMM DateTimes count days; the engine's clocks count seconds and the output
 * reader milliseconds. Every conversion between them reads these two values
 * (the engine's `constants::SEC_PER_DAY` and `MSEC_PER_DAY`).
 *
 * @license  Apache-2.0
 */

/** Seconds per day: SWMM DateTime days → engine seconds. */
export const SECONDS_PER_DAY = 86_400;

/** Milliseconds per day: SWMM DateTime days → `Date` milliseconds. */
export const MS_PER_DAY = 86_400_000;
