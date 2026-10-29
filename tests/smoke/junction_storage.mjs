/** Real WASM regression for openswmm.engine#10 / USEPA#200. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import createOpenSwmmModule from "../../dist/openswmm_engine.js";
import { Solver } from "../../dist/index.js";

// Keep a failed assertion from dumping the minified Emscripten glue line.
process.on("uncaughtException", (error) => {
  console.error(`junction_storage: ${error.message}`);
  process.exit(1);
});
const mod = await createOpenSwmmModule();
mkdirSync("tests/_work/junction_storage", { recursive: true });
for (const units of ["CFS", "LPS"]) {
  const solver = new Solver(mod);
  const text = `[OPTIONS]
FLOW_UNITS ${units}
FLOW_ROUTING DYNWAVE
START_DATE 01/01/2026
END_DATE 01/01/2026
END_TIME 00:10:00
ROUTING_STEP 1
VARIABLE_STEP 0
REPORT_STEP 00:00:10
MIN_SURFAREA 100
[JUNCTIONS]
J1 0 10 0 0 0
[OUTFALLS]
O1 0 FREE NO
[INFLOWS]
J1 FLOW "" FLOW 1 1 0.001
[REPORT]
NODES ALL
`;
  solver.writeFile("/chamber.inp", text);
  solver.open("/chamber.inp", "/chamber.rpt", "/chamber.out");
  const node = solver.nodes.get("J1");
  assert.equal(node.storageArea, 0);
  node.storageArea = 0.125;
  assert.equal(node.storageArea, 0.125);
  solver.fields.set("node.storage_area", "J1", 0.25);
  assert.equal(solver.fields.get("node.storage_area", "J1"), 0.25);
  assert.equal(node.storageArea, 0.25);
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(() => (node.storageArea = value));
  assert.throws(() => (solver.nodes.get("O1").storageArea = 1));
  solver.writeModel("/saved.inp");
  const saved = solver.readFile("/saved.inp", "utf8");
  assert.match(saved, /^J1\s+0\s+10\s+0\s+0\s+0\s+0\.25\s*$/m);
  writeFileSync(`tests/_work/junction_storage/${units}.inp`, saved);
  solver.initialize();
  assert.throws(() => (node.storageArea = 0.5));
  solver.start(true);
  let steps = 0;
  while (solver.step() > 0) steps++;
  assert.ok(steps > 500);
  // The existing SI output-volume conversion is 0.02832, while lengths use 0.3048.
  const volumeFactor = units === "LPS" ? 0.02832 / 0.3048 ** 3 : 1;
  assert.ok(Math.abs(node.volume - 0.25 * node.depth * volumeFactor) < 1e-10);
  solver.end();
  solver.report();
  solver.close();
  const report = solver.readFile("/chamber.rpt", "utf8");
  writeFileSync(`tests/_work/junction_storage/${units}.rpt`, report);
  const routing = report.slice(report.indexOf("Flow Routing Continuity"));
  const match = /Continuity Error \(%\) \.+\s+(-?[\d.]+)/.exec(routing);
  assert.ok(match);
  assert.ok(Math.abs(Number(match[1])) < 0.1);
  assert.throws(() => node.storageArea);
  solver.destroy();
}
// A dry, pipe-connected chamber must conserve the entire small inflow.
// Exercise the pinned engine, independently of native working-tree changes.
for (const routing of ["DYNWAVE", "FV"]) {
  const solver = new Solver(mod);
  const input = `[OPTIONS]
FLOW_UNITS CFS
FLOW_ROUTING ${routing}
FV_BACKEND CPU
START_DATE 01/01/2026
END_DATE 01/01/2026
END_TIME 00:10:00
ROUTING_STEP 0.1
MINIMUM_STEP 0.1
VARIABLE_STEP 0
MAX_TRIALS 30
HEAD_TOLERANCE 0.0000001
MIN_SURFAREA 100
REPORT_STEP 00:00:10
[JUNCTIONS]
J1 0 10 0 0 0 0.125
J2 0 10 0 0 0 0.125
[OUTFALLS]
O1 0 FREE NO
[CONDUITS]
C1 J1 J2 100 0.013 0 0 0
[XSECTIONS]
C1 CIRCULAR 1 0 0 0 1
[INFLOWS]
J1 FLOW "" FLOW 1 1 0.001
[REPORT]
NODES ALL
LINKS ALL
`;
  solver.writeFile("/small-chambers.inp", input);
  solver.open("/small-chambers.inp", "/small-chambers.rpt", "/small-chambers.out");
  solver.initialize();
  solver.start(true);
  const first = solver.nodes.get("J1"),
    second = solver.nodes.get("J2");
  // Match the native balance test: account for initialized conduit inventory.
  const initial = first.volume + second.volume + solver.links.get("C1").volume;
  while (solver.step() > 0) {}
  const total = first.volume + second.volume + solver.links.get("C1").volume - initial;
  assert.ok(Math.abs(total - 0.6) < 0.0006, `${routing}: stored ${total} ft3, expected 0.6`);
  for (const node of [first, second]) assert.ok(Math.abs(node.volume - 0.125 * node.depth) < 1e-10);
  solver.end();
  solver.report();
  solver.close();
  writeFileSync(`tests/_work/junction_storage/small-${routing}.inp`, input);
  writeFileSync(
    `tests/_work/junction_storage/small-${routing}.rpt`,
    solver.readFile("/small-chambers.rpt", "utf8"),
  );
  solver.destroy();
}
console.log(
  "junction_storage: writable property/catalog, units, lifecycle, serialization and continuity OK",
);
