// Read saved results: the run's binary output (.out) through Results and OutputReader.
//
//   node docs/examples/results.mjs
import { readFileSync } from "node:fs";

import createOpenSwmmModule from "@hydrocouple/openswmm-engine-wasm/wasm";
import { OutNodeVar, OutputReader, Solver, slice } from "@hydrocouple/openswmm-engine-wasm";

const inp = readFileSync(new URL("../../tests/fixtures/smoke.inp", import.meta.url), "utf8");
const mod = await createOpenSwmmModule();
const solver = new Solver(mod);
solver.writeFile("/model.inp", inp);
solver.open("/model.inp", "/model.rpt", "/model.out");
solver.initialize();
solver.start(true); // true (the default) saves results to the .out file
while (solver.step() > 0);
solver.end();

// Results opens the files of this run; fields describe a variable and load on read().
const results = solver.openResults();
console.log("report periods:", results.times.length, "first", results.times[0].toISOString());
console.log("node variables:", [...results.nodes.variables.keys()].join(", "));

const depth = results.nodes.variables.get("depth");
console.log("depth:", depth.units, depth.dimensions, depth.shape);
const firstHour = depth.read({ objects: ["J1", "J2"], periods: slice(0, 12) });
const [j1, j2] = firstHour.data.slice(-2); // row-major [period, object]: the 01:00 row
console.log("shape", firstHour.shape, "at 01:00 J1", j1.toFixed(3), "J2", j2.toFixed(3));
const history = results.nodes.get("J1").variables.get("depth").read();
console.log("J1 peak depth:", Math.max(...history.data).toFixed(3), depth.units);
results.close();

solver.close();
solver.destroy();

// OutputReader reads any .out in the module's file system, with or without a Solver.
const reader = new OutputReader(mod, "/model.out");
console.log("reader:", reader.nodeCount, "nodes,", reader.periodCount, "periods");
const series = reader.nodeSeries("J1", OutNodeVar.DEPTH);
console.log("J1 depth series:", series.length, "values, max", Math.max(...series).toFixed(3));
reader.close();
