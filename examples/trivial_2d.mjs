/**
 * Trivial 2D example: rain on a 100 m x 100 m sloped plane (two triangles)
 * that drains through its low edge. No 1D network.
 *
 *   npm run build && node examples/trivial_2d.mjs
 *
 * Needs the compiled module in dist/ (npm run build:wasm). The report is
 * written to tests/_work/trivial_2d.rpt. `npm run smoke` runs this script and
 * fails if the checks at the end stop holding.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import createOpenSwmmModule from "@hydrocouple/openswmm-engine-wasm/wasm";
import { Solver } from "@hydrocouple/openswmm-engine-wasm";

const here = dirname(fileURLToPath(import.meta.url));

const mod = await createOpenSwmmModule();
const solver = new Solver(mod);
solver.writeFile("/trivial_2d.inp", readFileSync(resolve(here, "trivial_2d.inp"), "utf8"));

solver.open("/trivial_2d.inp", "/trivial_2d.rpt", "/trivial_2d.out");
solver.initialize();
const mesh = solver.surface2d;
console.log(`mesh: ${mesh.nVertices} vertices, ${mesh.nTriangles} triangles`);

solver.start();
let peak = 0;
while (solver.step() > 0) {
  peak = Math.max(peak, mesh.maxDepth); // deepest cell this step, m
}
const balance = mesh.getMassBalance(); // m³, SI whatever the model's units
const finished = solver.currentDatetime;

solver.end();
solver.report();
solver.close();
const report = solver.readFile("/trivial_2d.rpt", "utf8");
solver.destroy();

console.log(`peak depth   ${peak.toFixed(4)} m`);
console.log(`rainfall in  ${balance.rainfallIn.toFixed(3)} m³`);
console.log(`edge outflow ${balance.boundaryOut.toFixed(3)} m³`);
console.log(`still stored ${balance.finalStorage.toFixed(3)} m³`);
console.log(`continuity   ${balance.continuityError.toExponential(2)} %`);

const work = resolve(here, "..", "tests", "_work");
mkdirSync(work, { recursive: true });
writeFileSync(resolve(work, "trivial_2d.rpt"), report);

// ---- Checks (kept honest by `npm run smoke`) --------------------------------
// 50 mm/h for 30 minutes on 10 000 m² is 250 m³.
check(Math.abs(balance.rainfallIn - 250) < 1e-6, `rainfall ${balance.rainfallIn} m³, expected 250`);
check(balance.boundaryOut > 0, "no water left through the boundary edge");
check(Math.abs(balance.continuityError) < 0.1, `continuity error ${balance.continuityError} %`);
check(
  finished.toISOString() === "2024-01-01T02:00:00.000Z",
  `run ended at ${finished.toISOString()}`,
);
console.log("trivial_2d: OK");

function check(ok, message) {
  if (!ok) {
    console.error(`trivial_2d: FAIL — ${message}`);
    process.exit(1);
  }
}
