/**
 * @file units.test.ts
 * @brief The shared time-unit constants are the engine's values and agree with each other.
 */
import { describe, it, expect } from "vitest";
import { MS_PER_DAY, SECONDS_PER_DAY } from "../../src/js/units.js";

describe("units", () => {
  it("defines seconds and milliseconds per day once, as the engine does", () => {
    expect(SECONDS_PER_DAY).toBe(86400);
    expect(MS_PER_DAY).toBe(86400000);
    expect(MS_PER_DAY).toBe(SECONDS_PER_DAY * 1000);
  });
});
