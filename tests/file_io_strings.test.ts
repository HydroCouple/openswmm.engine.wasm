import { describe, expect, it } from "vitest";
import { withCString, withCStrings } from "../src/js/mem.js";
import type { OpenSwmmWasmModule } from "../src/js/types.js";

function memoryModule() {
  const bytes = new Uint8Array(128 * 1024);
  let next = 16;
  const freed: number[] = [];
  const mod = {
    HEAPU8: bytes,
    _malloc(size: number) {
      const ptr = next;
      next += size;
      return next <= bytes.length ? ptr : 0;
    },
    _free(ptr: number) {
      freed.push(ptr);
    },
    UTF8ToString(ptr: number, limit?: number) {
      const end = bytes.indexOf(0, ptr);
      return new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(ptr, limit ? Math.min(end, ptr + limit) : end),
      );
    },
  } as unknown as OpenSwmmWasmModule;
  const write = (ptr: number, size: number, value: string) => {
    const encoded = new TextEncoder().encode(value);
    bytes.set(encoded.subarray(0, size - 1), ptr);
    bytes[ptr + Math.min(encoded.length, size - 1)] = 0;
  };
  return { mod, write, freed };
}

describe("native string readers", () => {
  it("retries before decoding a split UTF-8 sequence", () => {
    const { mod, write, freed } = memoryModule();
    const expected = "a".repeat(254) + "☔" + "雪".repeat(1000);
    let calls = 0;
    const result = withCString(mod, 256, (ptr, size) => {
      calls++;
      write(ptr, size, expected);
      return 0;
    });
    expect(result).toBe(expected);
    expect(calls).toBeGreaterThan(1);
    expect(freed).toHaveLength(calls);
  });

  it("retries both outputs when only one was truncated", () => {
    const { mod, write, freed } = memoryModule();
    const expected = "p".repeat(5000);
    const result = withCStrings(mod, 256, 2, ([first, second], size) => {
      write(first, size, "plugin");
      write(second, size, expected);
      return 0;
    });
    expect(result).toEqual(["plugin", expected]);
    expect(freed.length).toBeGreaterThan(2);
  });

  it("frees buffers and raises on a native error", () => {
    const { mod, freed } = memoryModule();
    expect(() => withCString(mod, 256, () => 10)).toThrow();
    expect(freed).toHaveLength(1);
  });
});
