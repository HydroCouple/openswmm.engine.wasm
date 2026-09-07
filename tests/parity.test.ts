/**
 * @file parity.test.ts
 * @brief Raw-layer parity with the Python bindings.
 *
 * @details Every `swmm_*` C function the Python bindings call
 * (`python/openswmm/engine/*.pyx` in the engine submodule) must be present in
 * the generated raw layer, except functions declared in headers that are
 * compiled out of the WASM build (2D / infil2d, listed in the manifest).
 *
 * Skipped with a message when the engine submodule (or ENGINE_ROOT) is not
 * checked out.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import manifest from "../src/js/raw.manifest.json" with { type: "json" };
import { RAW_FUNCTION_COUNT } from "../src/js/raw.js";

const engineRoot = process.env.ENGINE_ROOT ?? resolve(__dirname, "..", "extern", "openswmm.engine");
const pyxDir = resolve(engineRoot, "python", "openswmm", "engine");
const havePython = existsSync(pyxDir);

// C functions the Python layer calls through a different library
// (openswmm.output SMO_* reader) or that are not part of the engine C API.
const NOT_ENGINE_API = new Set<string>([]);

function pythonSurface(): Map<string, Set<string>> {
  const byModule = new Map<string, Set<string>>();
  for (const f of readdirSync(pyxDir)) {
    if (!f.endsWith(".pyx")) continue;
    const text = readFileSync(resolve(pyxDir, f), "utf8");
    const names = new Set<string>();
    for (const m of text.matchAll(/\b(swmm_[a-z0-9_]+)\s*\(/g)) names.add(m[1]);
    byModule.set(f, names);
  }
  return byModule;
}

describe("raw layer", () => {
  it("manifest and raw.ts agree", () => {
    expect(Object.keys(manifest.functions).length).toBe(RAW_FUNCTION_COUNT);
  });

  it("excludes only the 2D headers", () => {
    expect(manifest.excludedHeaders).toEqual(["openswmm_2d.h", "openswmm_infil2d.h"]);
  });
});

describe.skipIf(!havePython)("Python parity", () => {
  const surface = pythonSurface();
  const excluded = new Set(manifest.excludedFunctions);
  const raw = new Set(Object.keys(manifest.functions));

  it("found the Python modules", () => {
    expect(surface.size).toBeGreaterThan(20);
  });

  for (const [mod, names] of surface) {
    it(`${mod}: every swmm_* call exists in the raw layer`, () => {
      const missing = [...names]
        .filter((n) => !raw.has(n) && !excluded.has(n) && !NOT_ENGINE_API.has(n))
        .sort();
      expect(missing).toEqual([]);
    });
  }
});

if (!havePython) {
  console.warn(`parity: engine Python sources not found at ${pyxDir} — parity tests skipped`);
}
