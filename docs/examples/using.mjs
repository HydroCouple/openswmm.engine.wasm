// `using` frees the engine when the block ends (explicit resource management).
//
//   node docs/examples/using.mjs   # needs a runtime with `using` support
import createOpenSwmmModule from "@hydrocouple/openswmm-engine-wasm/wasm";
import { EngineState, Solver } from "@hydrocouple/openswmm-engine-wasm";

const mod = await createOpenSwmmModule();
let kept;
{
  using solver = new Solver(mod);
  kept = solver;
  console.log("inside the block:", EngineState[solver.state]);
} // solver[Symbol.dispose]() runs here and calls destroy()
try {
  console.log("state:", kept.state); // throws: the engine is gone
} catch (err) {
  console.log("after the block:", err.name, "-", err.message);
}
