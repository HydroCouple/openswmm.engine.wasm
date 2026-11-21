// The raw layer: every exported C function, typed, called with heap pointers and return codes.
//
//   node docs/examples/raw_layer.mjs
import { readFileSync } from "node:fs";

import createOpenSwmmModule from "@hydrocouple/openswmm-engine-wasm/wasm";
import {
  RAW_FUNCTION_COUNT,
  Solver,
  capabilities,
  rawOf,
  raiseForCode,
  withDouble,
} from "@hydrocouple/openswmm-engine-wasm";

const mod = await createOpenSwmmModule();
const raw = rawOf(mod); // bound once per module instance; bindRaw(mod) builds a fresh table
console.log("C functions:", RAW_FUNCTION_COUNT, "| ABI:", raw.swmm_engine_abi_tag().split(":")[0]);

// Raw calls take the engine handle and return a status code; out-parameters are heap pointers.
const engine = raw.swmm_engine_create();
mod.FS.writeFile(
  "/model.inp",
  readFileSync(new URL("../../tests/fixtures/smoke.inp", import.meta.url), "utf8"),
);
raiseForCode(raw.swmm_engine_open(engine, "/model.inp", "/model.rpt", "/model.out", null));
console.log("nodes:", raw.swmm_node_count(engine));

const ptr = mod._malloc(8);
raiseForCode(raw.swmm_node_get_invert_elev(engine, 0, ptr));
console.log("invert of node 0:", mod.getValue(ptr, "double"));
mod._free(ptr);
raw.swmm_engine_destroy(engine);

// The helpers the wrappers use do the allocation, the status check and the free.
const solver = new Solver(mod);
solver.open("/model.inp", "/model.rpt", "/model.out");
const elevation = withDouble(mod, (p) => raw.swmm_node_get_invert_elev(solver.handle, 1, p));
console.log("invert of node 1:", elevation);
solver.destroy();

// What this build includes (the same document as Python's openswmm.engine.capabilities()).
const caps = capabilities(mod);
console.log("features:", caps.features, "| threads:", caps.threads.logical_cpus);
