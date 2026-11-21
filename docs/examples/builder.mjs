// Build a model through the API instead of a .inp file, save it, and run it.
//
//   node docs/examples/builder.mjs
import createOpenSwmmModule from "@hydrocouple/openswmm-engine-wasm/wasm";
import {
  EngineState,
  ForcingMode,
  LinkType,
  ModelBuilder,
  NodeType,
  XSectShape,
} from "@hydrocouple/openswmm-engine-wasm";

const mod = await createOpenSwmmModule();
const builder = new ModelBuilder(mod); // an engine in BUILDING state

builder.setOption("FLOW_UNITS", "CMS");
// Set the whole period: the builder's default END_DATE (12/30/1899) is before its start.
builder.setOption("START_DATE", "01/01/2026");
builder.setOption("END_DATE", "01/01/2026");
builder.setOption("END_TIME", "01:00:00");
const j1 = builder.addNode("J1", NodeType.JUNCTION);
const out = builder.addNode("OUT1", NodeType.OUTFALL);
builder.setNodeInvert(j1, 10);
builder.setNodeMaxDepth(j1, 3);
builder.setNodeInvert(out, 9);
const c1 = builder.addLink("C1", LinkType.CONDUIT);
builder.setLinkNodes(c1, j1, out);
builder.setLinkLength(c1, 300);
builder.setLinkRoughness(c1, 0.013);
builder.setLinkXsect(c1, XSectShape.CIRCULAR, 0.5);

builder.validate(); // topology checks; the state does not change
builder.write("/built.inp"); // the model as a .inp file in the module's file system
builder.finalize(); // BUILDING -> INITIALIZED
const solver = builder.toSolver(); // the Solver owns the engine from here on
console.log("state:", EngineState[solver.state]);

solver.start();
// Forcing flows are internal ft³/s whatever FLOW_UNITS says: convert 0.05 m³/s first.
const FT3_PER_M3 = 35.3146667;
solver.forcing.nodeLatInflow(j1, 0.05 * FT3_PER_M3, ForcingMode.REPLACE, true);
while (solver.step() > 0);
console.log(`C1 flow at the end: ${solver.links.get("C1").flow.toFixed(4)} m³/s`);
solver.end();
solver.destroy();

const text = solver.readFile("/built.inp", "utf8");
const sections = ["[JUNCTIONS]", "[OUTFALLS]", "[CONDUITS]"];
console.log(text.split("\n").filter((line) => sections.includes(line.trim())));
