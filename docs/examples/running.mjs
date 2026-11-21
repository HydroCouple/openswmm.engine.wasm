// Ways to drive a run: one call, the stepping helpers, and callbacks.
//
//   node docs/examples/running.mjs
import { readFileSync } from "node:fs";

import createOpenSwmmModule from "@hydrocouple/openswmm-engine-wasm/wasm";
import { EngineState, Solver, run } from "@hydrocouple/openswmm-engine-wasm";

const inp = readFileSync(new URL("../../tests/fixtures/smoke.inp", import.meta.url), "utf8");
const mod = await createOpenSwmmModule();
mod.FS.writeFile("/model.inp", inp);

// 1. A whole run in one call, without a Solver object.
run(mod, "/model.inp", "/once.rpt", "/once.out");
const report = mod.FS.readFile("/once.rpt", { encoding: "utf8" });
console.log("run(): report has", report.length, "chars");

// 2. Solver.run() opens, steps and closes; the engine can then open a model again.
const solver = new Solver(mod);
solver.run("/model.inp", "/model.rpt", "/model.out");
console.log("after solver.run():", EngineState[solver.state]);

// 3. Step to a time, then iterate the remaining steps, with a callback after each step.
solver.open("/model.inp", "/model.rpt", "/model.out");
solver.initialize();
solver.start();
let callbacks = 0;
solver.setStepEndCallback(() => callbacks++);

console.log("advanceTo(3600) reached", solver.advanceTo(3600), "s");
console.log("until(02:00 UTC) reached", solver.until(new Date(Date.UTC(2026, 0, 1, 2))), "s");
let remaining = 0;
for (const _elapsed of solver.steps()) remaining++;
console.log(`${remaining} more steps; ${callbacks} step-end callbacks in all`);
console.log("state:", EngineState[solver.state], "elapsed:", solver.elapsed, "s");

solver.end();
solver.close();
solver.destroy();
