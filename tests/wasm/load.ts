/**
 * Loader for the real-module test tier (tests/wasm/*.test.ts).
 *
 * These tests run the compiled engine from dist/: the Emscripten output
 * (openswmm_engine.{js,wasm}) and the TypeScript build (index.js, raw.js). When
 * either is missing the suites are skipped, and their titles say why. Files the
 * tests write go to tests/_work/wasm/.
 */
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenSwmmWasmModule } from "../../src/js/types.js";

export const root = resolve(__dirname, "..", "..");
export const dist = resolve(root, "dist");
export const fixtures = resolve(root, "tests", "fixtures");
export const work = resolve(root, "tests", "_work", "wasm");

const REQUIRED = ["openswmm_engine.js", "openswmm_engine.wasm", "index.js", "raw.js"];

/** True when dist/ holds both the Emscripten and the TypeScript build. */
export const built = REQUIRED.every((f) => existsSync(resolve(dist, f)));

/** Suite title that states the skip reason when dist/ is incomplete. */
export const title = (name: string) =>
  built ? name : `${name} (skipped: build dist/ with the Emscripten build and \`npm run build\`)`;

/** A fresh module instance plus the package and raw layer built from it. */
export async function load() {
  const url = (f: string) => pathToFileURL(resolve(dist, f)).href;
  const { default: create } = (await import(url("openswmm_engine.js"))) as {
    default: () => Promise<OpenSwmmWasmModule>;
  };
  const pkg = (await import(url("index.js"))) as typeof import("../../src/js/index.js");
  const raw = (await import(url("raw.js"))) as typeof import("../../src/js/raw.js");
  const mem = (await import(url("mem.js"))) as typeof import("../../src/js/mem.js");
  mkdirSync(work, { recursive: true });
  return { mod: await create(), pkg, raw, mem };
}
