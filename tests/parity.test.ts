import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import manifest from "../src/js/raw.manifest.json" with { type: "json" };
import { RAW_FUNCTION_COUNT } from "../src/js/raw.js";

const engineRoot = process.env.ENGINE_ROOT ?? resolve(__dirname, "..", "extern", "openswmm.engine");
// Use the engine's tokenizer: comments, docstrings and extern declarations
// are not executable uses; shared .pxd helpers are. Missing sources fail CI.
const surface = JSON.parse(execFileSync(process.env.PYTHON ?? "python3", [
  resolve(__dirname, "../tools/check_python_parity.py"), "--engine-root", engineRoot,
], { encoding: "utf8" })) as Record<string, string[]>;

describe("raw layer", () => {
  it("manifest and raw.ts agree", () => {
    expect(Object.keys(manifest.functions).length).toBe(RAW_FUNCTION_COUNT);
  });
  it("excludes exactly the disabled 2D feature headers", () => {
    expect(manifest.excludedHeaders).toEqual([
      "openswmm_2d.h", "openswmm_gw2d.h", "openswmm_gw_transport.h",
      "openswmm_infil2d.h", "openswmm_sq2d.h",
    ]);
    for (const name of manifest.excludedFunctions) {
      expect(name in manifest.functions).toBe(false);
    }
  });
});
describe("Python executable coverage", () => {
  it("includes .pxd helpers as well as .pyx modules", () => {
    expect(Object.keys(surface).some(p => p.endsWith(".pxd"))).toBe(true);
    expect(surface).toHaveProperty("_common.pxd");
    expect(surface).toHaveProperty("_transport.pyx");
  });
  for (const [module, missing] of Object.entries(surface)) {
    it(`${module}: every C API use is exported or explicitly excluded`, () => {
      expect(missing).toEqual([]);
    });
  }
});
