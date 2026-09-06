/**
 * End-to-end smoke test against the compiled WASM module (Node).
 *
 * Requires: dist/openswmm_engine.js + .wasm (Emscripten build) and
 * dist/index.js (npm run build:ts).
 *
 *   npm run smoke
 *
 * Runs tests/fixtures/smoke.inp through the full lifecycle, writes the
 * report to tests/_work/smoke.wasm.rpt, and compares the outfall peak flow
 * and routing continuity error against the native engine reference in
 * tests/fixtures/smoke.native.rpt.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const dist = resolve(root, "dist");
const work = resolve(root, "tests", "_work");

for (const f of ["openswmm_engine.js", "openswmm_engine.wasm", "index.js"]) {
  if (!existsSync(resolve(dist, f))) {
    console.error(`smoke: missing dist/${f} — run the Emscripten build and 'npm run build:ts' first`);
    process.exit(2);
  }
}

const { default: createOpenSwmmModule } = await import(resolve(dist, "openswmm_engine.js"));
const { Solver } = await import(resolve(dist, "index.js"));

const mod = await createOpenSwmmModule();
const solver = new Solver(mod);

const inp = readFileSync(resolve(root, "tests", "fixtures", "smoke.inp"), "utf8");
solver.writeFile("/smoke.inp", inp);

solver.open("/smoke.inp", "/smoke.rpt", "/smoke.out");
solver.initialize();
solver.start(true);

let steps = 0;
let peakOutfall = 0;
const o1 = solver.nodes.getIndex("O1");
assert(o1 >= 0, "outfall O1 not found");
const outfall = solver.nodes.get(o1);
while (solver.step() > 0) {
  steps++;
  peakOutfall = Math.max(peakOutfall, outfall.inflow);
}
solver.end();
solver.report();
solver.close();

const rpt = solver.readFile("/smoke.rpt", "utf8");
solver.destroy();

mkdirSync(work, { recursive: true });
writeFileSync(resolve(work, "smoke.wasm.rpt"), rpt);

// ---- Compare against the native reference ---------------------------------
const ref = readFileSync(resolve(root, "tests", "fixtures", "smoke.native.rpt"), "utf8");
const refPeak = outfallPeak(ref, "O1");
const wasmPeak = outfallPeak(rpt, "O1");
const refCE = routingContinuityError(ref);
const wasmCE = routingContinuityError(rpt);

console.log(`smoke: ${steps} routing steps`);
console.log(`smoke: O1 peak flow   native=${refPeak}  wasm=${wasmPeak}  (stepwise max inflow ${peakOutfall.toFixed(3)})`);
console.log(`smoke: routing CE (%) native=${refCE}  wasm=${wasmCE}`);

assert(steps > 100, `too few steps: ${steps}`);
assert(/Continuity Error/.test(rpt), "report lacks continuity section");
assert(relDiff(refPeak, wasmPeak) < 0.02, `outfall peak differs >2%: ${refPeak} vs ${wasmPeak}`);
assert(Math.abs(wasmCE) < 1.0, `routing continuity error too large: ${wasmCE}%`);
console.log("smoke: OK");

// ---- helpers ----------------------------------------------------------------
function assert(cond, msg) {
  if (!cond) {
    console.error(`smoke: FAIL — ${msg}`);
    process.exit(1);
  }
}
function relDiff(a, b) {
  return Math.abs(a - b) / Math.max(Math.abs(a), 1e-9);
}
function outfallPeak(text, id) {
  const m = new RegExp(`^\\s*${id}\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)`, "m").exec(
    text.slice(text.indexOf("Outfall Loading Summary")),
  );
  assert(m, `no outfall row for ${id}`);
  return Number(m[3]);
}
function routingContinuityError(text) {
  const i = text.indexOf("Flow Routing Continuity");
  const m = /Continuity Error \(%\) \.+\s+(-?[\d.]+)/.exec(text.slice(i));
  assert(m, "no routing continuity error");
  return Number(m[1]);
}
