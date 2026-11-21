// Quick start: run a small 1D model step by step, then read the report.
//
//   node docs/examples/quickstart.mjs
//
// Runs from a clone with the compiled module in dist/. The model is the one the
// smoke tests run: 1 rain gage, 2 subcatchments, 3 junctions, 3 conduits, 1 outfall.
import { readFileSync } from "node:fs";

import createOpenSwmmModule from "@hydrocouple/openswmm-engine-wasm/wasm";
import { FlowUnits, Solver } from "@hydrocouple/openswmm-engine-wasm";

const inp = readFileSync(new URL("../../tests/fixtures/smoke.inp", import.meta.url), "utf8");

// Compile and instantiate the WebAssembly module (asynchronous), then create an engine.
const mod = await createOpenSwmmModule();
const solver = new Solver(mod);

// The engine reads and writes files in the module's in-memory file system.
solver.writeFile("/model.inp", inp);

solver.open("/model.inp", "/model.rpt", "/model.out");
solver.initialize();
solver.start();

const lastPipe = solver.links.get("C3"); // the conduit that discharges to outfall O1
let peak = 0;
let steps = 0;
while (solver.step() > 0) {
  peak = Math.max(peak, lastPipe.flow);
  steps++;
}
console.log(`nodes ${solver.nodes.length}, links ${solver.links.length}`);
console.log(`${steps} routing steps, ended at ${solver.currentDatetime.toISOString()}`);
console.log(`peak flow in C3 ${peak.toFixed(3)} ${FlowUnits[solver.flowUnits]}`);

solver.end();
solver.report();
solver.close();

const report = solver.readFile("/model.rpt", "utf8");
for (const line of report.split("\n").filter((l) => l.includes("Continuity Error"))) {
  console.log(line.trim());
}

solver.destroy();
