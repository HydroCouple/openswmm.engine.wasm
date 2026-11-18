/**
 * Real module: raw-layer argument conversions that only the compiled module
 * can show.
 *
 * - 64-bit integers passed by value are wasm i64 values, which the module
 *   (built with WASM_BIGINT) accepts only as BigInt.
 * - cwrap copies string arguments onto the 1 MB stack; a larger string used to
 *   overrun it silently and corrupt memory, so the next call trapped. Large
 *   strings are now copied to the heap.
 */
import { describe, it, expect } from "vitest";
import { built, load, title } from "./load.js";

describe.skipIf(!built)(title("real module: raw-layer argument conversions"), () => {
  it("passes uint64_t arguments as BigInt", async () => {
    const { mod, mem } = await load();
    const raw = mem.rawOf(mod);
    // A null engine is refused natively (SWMM_ERR_BADHANDLE), after the call crossed into wasm.
    expect(raw.swmm_passive_exchange_enable(0, 4096n, 0)).toBe(7);
    expect(() => raw.swmm_passive_exchange_enable(0, 4096 as unknown as bigint, 0)).toThrow(
      TypeError,
    );
  });

  it("passes strings larger than the stack without corrupting memory", async () => {
    const { mod, mem } = await load();
    const raw = mem.rawOf(mod);
    for (const size of [1024, 2 * 1024 * 1024, 8 * 1024 * 1024]) {
      expect(raw.swmm_split_packet_decode(0, "x".repeat(size), size, 0)).toBe(7);
    }
    const handle = raw.swmm_engine_create();
    expect(handle).not.toBe(0);
    raw.swmm_engine_destroy(handle);
  });
});
