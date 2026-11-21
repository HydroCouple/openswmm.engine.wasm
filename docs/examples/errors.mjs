// Engine failures arrive as typed exceptions.
//
//   node docs/examples/errors.mjs
import { readFileSync } from "node:fs";

import createOpenSwmmModule from "@hydrocouple/openswmm-engine-wasm/wasm";
import {
  ElementNotFoundError,
  EngineError,
  EngineState,
  ErrorCode,
  ParseError,
  Solver,
} from "@hydrocouple/openswmm-engine-wasm";

const inp = readFileSync(new URL("../../tests/fixtures/smoke.inp", import.meta.url), "utf8");
const mod = await createOpenSwmmModule();
mod.FS.writeFile("/model.inp", inp);

function attempt(label, fn) {
  try {
    fn();
    console.log(`${label}: no error`);
  } catch (err) {
    if (!(err instanceof EngineError)) throw err;
    console.log(`${label}: ${err.name}, code ${err.code} (${ErrorCode[err.codeEnum]})`);
    return err;
  }
}

// A call out of order is refused with LifecycleError. The refused call leaves this
// engine in state NONE, where it cannot open a model again, so use a throwaway Solver.
const early = new Solver(mod);
attempt("step() before open()", () => early.step());
console.log("  state afterwards:", EngineState[early.state]);
early.destroy();

// An unknown id raises ElementNotFoundError (a BadIndexError) with the id attached.
const solver = new Solver(mod);
solver.open("/model.inp", "/model.rpt", "/model.out");
const missing = attempt("nodes.get('J9')", () => solver.nodes.get("J9"));
console.log("  ElementNotFoundError:", missing instanceof ElementNotFoundError, missing.elementId);

// An error thrown by a JavaScript callback is rethrown when the engine call returns.
solver.initialize();
solver.start();
solver.setStepEndCallback((simTime) => {
  if (simTime > 0.01) throw new RangeError("stop here");
});
try {
  while (solver.step() > 0);
} catch (err) {
  console.log(`callback error: ${err.name}: ${err.message}`);
}
solver.setStepEndCallback(null);
solver.end();
solver.close();
solver.destroy();

// A deck the parser refuses raises ParseError; openErrors lists what was wrong.
const parser = new Solver(mod);
parser.writeFile("/bad.inp", "[CONDUITS]\nC1 J1 O1 100 0.01 0 0\n"); // J1 and O1 are not defined
const bad = attempt("open(bad.inp)", () => parser.open("/bad.inp", "/bad.rpt", "/bad.out"));
console.log("  ParseError:", bad instanceof ParseError);
for (const line of parser.openErrors) console.log(" ", line.trim());
parser.destroy();
