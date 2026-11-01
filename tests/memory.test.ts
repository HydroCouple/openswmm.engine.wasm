import { describe, expect, it, vi } from "vitest";
import {
  checkedAlloc,
  withDouble,
  withDoubleArray,
  withDoubleInput,
  withInt,
  withCStrings,
} from "../src/js/mem.js";
import type { OpenSwmmWasmModule } from "../src/js/types.js";

describe("heap allocation failures", () => {
  it.each([withDouble, withInt])(
    "refuses null scalar outputs before calling native code",
    (helper) => {
      const call = vi.fn();
      const mod = { _malloc: () => 0 } as unknown as OpenSwmmWasmModule;
      expect(() => helper(mod, call)).toThrow(RangeError);
      expect(call).not.toHaveBeenCalled();
    },
  );
  it("does not write input or call native code after a failed allocation", () => {
    const heap = new Float64Array([11, 22]);
    const call = vi.fn();
    const mod = { _malloc: () => 0, HEAPF64: heap } as unknown as OpenSwmmWasmModule;
    expect(() => withDoubleInput(mod, [123], call)).toThrow(RangeError);
    expect([...heap]).toEqual([11, 22]);
    expect(call).not.toHaveBeenCalled();
    expect(() => withDoubleArray(mod, 1, call)).toThrow(RangeError);
  });
  it("frees earlier string buffers when a later allocation fails", () => {
    const free = vi.fn();
    let allocations = 0;
    const mod = {
      _malloc: () => (++allocations === 1 ? 8 : 0),
      _free: free,
      HEAPU8: new Uint8Array(1024),
    } as unknown as OpenSwmmWasmModule;
    const call = vi.fn();
    expect(() => withCStrings(mod, 256, 3, call)).toThrow(RangeError);
    expect(free.mock.calls).toEqual([[8]]);
    expect(call).not.toHaveBeenCalled();
  });
  it("rejects invalid wasm32 sizes before allocation", () => {
    const malloc = vi.fn();
    const mod = { _malloc: malloc } as unknown as OpenSwmmWasmModule;
    for (const n of [-1, 0, 1.5, NaN, Infinity, 2 ** 32])
      expect(() => checkedAlloc(mod, n)).toThrow(RangeError);
    for (const n of [-1, 1.5, NaN, 2 ** 32])
      expect(() => withDoubleArray(mod, n, vi.fn())).toThrow(RangeError);
    expect(() => withDoubleInput(mod, { length: 2 ** 32 }, vi.fn())).toThrow(RangeError);
    expect(malloc).not.toHaveBeenCalled();
  });
  it("preserves heap-backed input when allocation grows WASM memory", () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
    const source = new Float64Array(memory.buffer, 0, 2);
    source.set([3, 7]);
    const free = vi.fn();
    const mod = {
      _malloc: () => {
        memory.grow(1);
        return 32;
      },
      _free: free,
      get HEAPF64() {
        return new Float64Array(memory.buffer);
      },
    } as unknown as OpenSwmmWasmModule;
    const call = vi.fn((p, n) => {
      expect([...new Float64Array(memory.buffer, p, n)]).toEqual([3, 7]);
      return 0;
    });
    withDoubleInput(mod, source, call);
    expect(free).toHaveBeenCalledWith(32);
  });
});
