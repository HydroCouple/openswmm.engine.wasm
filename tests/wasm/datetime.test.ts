/**
 * Real module: SWMM DateTime arithmetic through the engine (`encodeDate` ...
 * `timeDiff`), checked against the pure-TypeScript conversion in dates.ts.
 */
import { describe, it, expect } from "vitest";
import { built, load, title } from "./load.js";

describe.skipIf(!built)(title("real module: datetime"), () => {
  it("encodes and decodes dates and times like the pure conversion", async () => {
    const { mod, pkg } = await load();
    const day = pkg.encodeDate(mod, 2026, 11, 17);
    expect(day).toBe(pkg.datetimeToOadate(new Date(Date.UTC(2026, 10, 17))));
    expect(pkg.decodeDate(mod, day + 0.75)).toEqual([2026, 11, 17]);
    const t = pkg.encodeTime(mod, 18, 30, 15);
    expect(t).toBeCloseTo((18 * 3600 + 30 * 60 + 15) / 86400, 15);
    expect(pkg.decodeTime(mod, day + t)).toEqual([18, 30, 15]);
  });

  it("shifts and differences in whole seconds", async () => {
    const { mod, pkg } = await load();
    const start = pkg.encodeDate(mod, 2026, 1, 1);
    const later = pkg.addSeconds(mod, start, 90061); // 1 day 1 h 1 min 1 s
    expect(pkg.decodeDate(mod, later)).toEqual([2026, 1, 2]);
    expect(pkg.decodeTime(mod, later)).toEqual([1, 1, 1]);
    expect(pkg.timeDiff(mod, later, start)).toBe(90061);
    expect(pkg.timeDiff(mod, start, later)).toBe(-90061);
  });

  it("rejects invalid dates and times with BadParamError", async () => {
    const { mod, pkg } = await load();
    expect(() => pkg.encodeDate(mod, 2026, 13, 1)).toThrow(pkg.BadParamError);
    expect(() => pkg.encodeTime(mod, -1, 0, 0)).toThrow(pkg.BadParamError);
  });
});
