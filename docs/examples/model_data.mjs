// Read and edit a model through its element views, catalog fields and options.
//
//   node docs/examples/model_data.mjs
import { readFileSync } from "node:fs";

import createOpenSwmmModule from "@hydrocouple/openswmm-engine-wasm/wasm";
import { LinkType, NodeType, Solver } from "@hydrocouple/openswmm-engine-wasm";

const inp = readFileSync(new URL("../../tests/fixtures/smoke.inp", import.meta.url), "utf8");
const mod = await createOpenSwmmModule();
const solver = new Solver(mod);
solver.writeFile("/model.inp", inp);
solver.open("/model.inp", "/model.rpt", "/model.out");

// Collections: by index or id, iterable, with ids in index order.
for (const node of solver.nodes) {
  console.log(`node ${node.index} ${node.id} ${NodeType[node.type]} invert ${node.invertElev}`);
}
const c1 = solver.links.get("C1");
const route = `${c1.fromNode.id} -> ${c1.toNode.id}`;
console.log(`link C1 ${LinkType[c1.type]} ${route}, n = ${c1.roughness}`);
const s1 = solver.subcatchments.get("S1");
console.log("subcatchments", solver.subcatchments.ids, "area of S1", s1.area);

// Edits go in after open() and before initialize().
c1.roughness = 0.013;
solver.fields.set("link.roughness", "C2", 0.013); // the same property by catalog path
console.log("C2 roughness by path:", solver.fields.get("link.roughness", "C2"));
console.log("describe link.flow:", solver.fields.describe("link.flow").units);

console.log("ROUTING_STEP option:", solver.options.get("ROUTING_STEP"));
solver.options.set("ROUTING_STEP", 15);
console.log("ROUTING_STEP now:", solver.options.get("ROUTING_STEP"));

// Bulk arrays read every element in one call; each read is a copy.
solver.initialize();
solver.start();
let peakDepths = new Float64Array(solver.nodes.length);
let peakRunoff = 0;
while (solver.step() > 0) {
  const depths = solver.nodes.depths;
  peakDepths = peakDepths.map((d, i) => Math.max(d, depths[i]));
  peakRunoff = Math.max(peakRunoff, solver.subcatchments.get("S1").runoff);
}
console.log("routing step:", solver.routingStep, "s");
console.log("peak depths:", Array.from(peakDepths, (d) => d.toFixed(3)).join(" "));
console.log("peak runoff from S1:", peakRunoff.toFixed(3));

solver.end();
solver.close();
solver.destroy();
