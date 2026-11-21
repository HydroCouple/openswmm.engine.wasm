// Change a run while it steps: runtime forcing, and a control rule added before the run.
//
//   node docs/examples/forcing_controls.mjs
import { readFileSync } from "node:fs";

import createOpenSwmmModule from "@hydrocouple/openswmm-engine-wasm/wasm";
import { ForcingMode, ForcingTarget, Solver } from "@hydrocouple/openswmm-engine-wasm";

const inp = readFileSync(new URL("../../tests/fixtures/smoke.inp", import.meta.url), "utf8");
const mod = await createOpenSwmmModule();
mod.FS.writeFile("/model.inp", inp);

/** Run the model; `edit` runs after open(), `each` after every step. Returns C3's peak flow. */
function peakFlow({ edit = () => {}, each = () => {} } = {}) {
  const solver = new Solver(mod);
  solver.open("/model.inp", "/model.rpt", "/model.out");
  edit(solver);
  solver.initialize();
  solver.start();
  const c3 = solver.links.get("C3");
  let peak = 0;
  for (const elapsed of solver.steps()) {
    peak = Math.max(peak, c3.flow);
    each(solver, elapsed);
  }
  solver.end();
  solver.close();
  solver.destroy();
  return peak.toFixed(3);
}

console.log("baseline         ", peakFlow());

// Forcing: add 2 cfs at J1 for the first hour. persist = true keeps it until cleared;
// without it the value applies to the next step only.
let forcing = false;
console.log(
  "J1 +2 cfs, 1 hour",
  peakFlow({
    each(solver, elapsed) {
      const j1 = solver.nodes.getIndex("J1");
      if (!forcing && elapsed < 3600) {
        solver.forcing.nodeLatInflow(j1, 2.0, ForcingMode.ADD, true);
        forcing = true;
      } else if (forcing && elapsed >= 3600) {
        solver.forcing.clear(ForcingTarget.NODE, j1);
        forcing = false;
      }
    },
  }),
);

// Controls: a rule in [RULES] syntax, added after open() and before initialize().
console.log(
  "rule closes C1   ",
  peakFlow({
    edit(solver) {
      solver.controls.addRule("RULE R1\nIF NODE J1 DEPTH > 0.3\nTHEN CONDUIT C1 STATUS = CLOSED\n");
      const rule = solver.controls.get(solver.controls.length - 1);
      console.log(`  added ${rule.id}: ${rule.text.split("\n").length} lines`);
    },
  }),
);
