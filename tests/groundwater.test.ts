import { expect, it } from "vitest";
import { Groundwater, STRUCTS } from "../src/js/index.js";
import type { OpenSwmmWasmModule } from "../src/js/types.js";

it("decodes clock matrices and 64-bit counters without rounding", () => {
  const heap = new Uint8Array(4096);
  const view = new DataView(heap.buffer);
  const layout = STRUCTS.SWMM_GwClockStats;
  const mod = {
    _malloc: () => 16,
    _free: () => {},
    HEAPU8: heap,
    cwrap: () => () => 0,
    setValue: (p: number, value: number) => view.setInt32(p, value, true),
    _swmm_gw2d_get_clock_stats: (_h: number, p: number) => {
      expect(view.getInt32(p, true)).toBe(layout.size);
      view.setInt32(p + layout.fields.independent.offset, 1, true);
      view.setInt32(p + layout.fields.first_rung.offset, -3, true);
      for (let i = 0; i < 3; i++) {
        view.setBigUint64(p + layout.fields.firings.offset + 8 * i, 2n ** 60n + BigInt(i), true);
        for (let j = 0; j < 5; j++)
          view.setBigUint64(
            p + layout.fields.budget_exceedance.offset + 8 * (5 * i + j),
            BigInt(i * 10 + j),
            true,
          );
      }
      return 0;
    },
  } as unknown as OpenSwmmWasmModule;
  const stats = new Groundwater(mod, 1).clockStats;
  expect(stats.firstRung).toBe(-3);
  expect(stats.closures.CLOSED_FORM?.firings).toBe(2n ** 60n);
  expect(stats.closures.SIGMA?.firings).toBe(2n ** 60n + 2n);
  expect(stats.closures.ENSLAVED?.budgetExceedance).toEqual([10n, 11n, 12n, 13n, 14n]);
  heap.fill(0);
  expect(stats.closures.SIGMA?.firings).toBe(2n ** 60n + 2n);
});
