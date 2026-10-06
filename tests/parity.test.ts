import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import manifest from "../src/js/raw.manifest.json" with { type: "json" };
import exported from "../src/bindings/exported_functions.json" with { type: "json" };
import exportedNo2d from "../src/bindings/exported_functions.no2d.json" with { type: "json" };
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
  it("binds every engine header, 2D included", () => {
    expect(manifest.excludedHeaders).toEqual([]);
    expect(manifest.excludedFunctions).toEqual([]);
    expect(manifest.optionalHeaders["2d"]).toEqual([
      "openswmm_2d.h", "openswmm_gw2d.h", "openswmm_gw_transport.h",
      "openswmm_infil2d.h", "openswmm_sq2d.h",
    ]);
    const headers = new Set(Object.values(manifest.functions).map(f => f.header));
    for (const h of manifest.optionalHeaders["2d"]) expect(headers.has(h)).toBe(true);
  });
  it("the 1D-only export list drops exactly the 2D headers' functions", () => {
    const optional = new Set(manifest.optionalHeaders["2d"]);
    const all = Object.entries(manifest.functions);
    expect(exported).toEqual(["_malloc", "_free", ...all.map(([n]) => `_${n}`)]);
    expect(exportedNo2d).toEqual(["_malloc", "_free",
      ...all.filter(([, f]) => !optional.has(f.header)).map(([n]) => `_${n}`)]);
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
