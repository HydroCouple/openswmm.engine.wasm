/** Recent API contracts against a real WASM binary, in both project unit systems. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import createModule from "../../dist/openswmm_engine.js";
import {
  Solver,
  CellScope,
  GroundwaterVariable,
  BadIndexError,
  BadParamError,
  BadHandleError,
  LifecycleError,
  withDoubleInput,
} from "../../dist/index.js";

const mod = await createModule();
const fixture = readFileSync(new URL("../fixtures/groundwater.inp", import.meta.url), "utf8");
for (const units of ["CMS", "CFS"]) {
  const solver = new Solver(mod);
  const path = `/groundwater-${units}`;
  solver.writeFile(`${path}.inp`, fixture.replace("FLOW_UNITS CMS", `FLOW_UNITS ${units}`));
  solver.open(`${path}.inp`, `${path}.rpt`, `${path}.out`);
  const surface = solver.surface2d;
  const gw = surface.groundwater;
  const transport = gw.transport;
  gw.options.set("NODE_ENROLMENT", "ROWS");
  gw.options.set("GW_CLOCK", "INDEPENDENT");
  gw.options.set("GW_MAX_STEP", 4);
  gw.options.set("CLOSURE", "CLOSED_FORM");
  assert.equal(gw.options.get("GW_CLOCK"), "INDEPENDENT");
  gw.addRow({ scope: CellScope.GLOBAL, ks: 36, zs: 0.5, thetaS: 0.45, thetaR: 0.1, alpha: 2 });
  gw.setRowProperty(0, "HG0", 0.2);
  assert.equal(gw.rows[0].ks, 36);
  assert.equal(gw.rowProperty(0, "HG0"), 0.2);
  transport.setSource({ name: "Well", scope: CellScope.CELL, cell: 0, flow: 0.001 });
  transport.setSource({ name: "Pump", scope: CellScope.CELL, cell: 1, flow: 0 });
  transport.setSourceSpecies(0, { species: "TSS", kind: "CONC", value: 10 });
  transport.setSourceXy(0, 15, 2);
  assert.deepEqual(transport.sourceXy(0), [15, 2]);
  assert.equal(transport.sourceXy(1), null);
  const before = transport.sources[0];
  const terms = transport.sourceSpecies(0);
  transport.setSourceScale(0, 2.5);
  transport.setSourceXy(0, 5, 5);
  assert.deepEqual(transport.sources[0], { ...before, cell: 1 });
  assert.deepEqual(transport.sourceSpecies(0), terms);
  assert.equal(transport.sourceScale(0), 2.5);
  assert.throws(() => transport.sourceXy(-1), BadIndexError);
  assert.throws(() => transport.sourceSpecies(-1), BadIndexError);
  assert.throws(() => transport.setSourceXy(0, NaN, 0), BadParamError);
  assert.deepEqual(transport.sourceXy(0), [5, 5]);
  solver.writeModel(`${path}-saved.inp`);
  const reopened = new Solver(mod);
  reopened.open(`${path}-saved.inp`, `${path}-saved.rpt`, `${path}-saved.out`);
  assert.deepEqual(reopened.surface2d.groundwater.transport.sourceXy(0), [5, 5]);
  assert.deepEqual(reopened.surface2d.groundwater.transport.sources, transport.sources);
  reopened.close();
  reopened.destroy();
  solver.initialize();
  assert.throws(() => transport.setSourceXy(0, 15, 2), LifecycleError);
  solver.start(false);
  for (let i = 0; i < 10; i++) solver.step();
  assert(gw.active);
  assert.equal(gw.dimensions[0], 2);
  const stats = gw.clockStats;
  assert(stats.independent);
  assert(stats.closures.CLOSED_FORM.firings > 0n);
  assert.equal(stats.closures.CLOSED_FORM.budgetExceedance.length, 5);
  assert.equal(gw.tierHistogram.length, stats.lastRung - stats.firstRung + 1);
  assert(gw.cells(GroundwaterVariable.COMPLETED_TIME).every((x) => x > 0));
  for (const variable of [GroundwaterVariable.PENDING_IN, GroundwaterVariable.PENDING_OUT])
    assert(gw.cells(variable).every((x) => x >= 0));
  const state = gw.cells(GroundwaterVariable.HG);
  assert.equal(state[0], gw.cell(0, GroundwaterVariable.HG));
  state.fill(-999);
  assert(gw.cell(0, GroundwaterVariable.HG) >= 0);
  const [vx, vy] = surface.getVelocities();
  assert.equal(vx.length, 2);
  assert.equal(vy.length, 2);
  vx.fill(-999);
  assert(surface.getVelocities()[0].every((x) => x !== -999));
  assert.deepEqual(gw.clockStats, stats); // reads do not advance the clock
  solver.end();
  solver.close();
  solver.destroy();
  assert.throws(() => gw.clockStats, BadHandleError);
}
// Trigger actual Emscripten heap growth while uploading a heap-backed input.
const p = mod._malloc(16);
mod.HEAPF64.set([3, 7], p / 8);
const input = new Float64Array(mod.HEAPF64.buffer, p, 2);
const malloc = mod._malloc;
const oldSize = mod.HEAPU8.byteLength;
let growthBlock;
mod._malloc = (bytes) => {
  growthBlock = malloc(oldSize + 65536);
  return malloc(bytes);
};
try {
  withDoubleInput(mod, input, (ptr, count) => {
    assert.deepEqual([...new Float64Array(mod.HEAPF64.buffer, ptr, count)], [3, 7]);
    return 0;
  });
  assert(mod.HEAPU8.byteLength > oldSize);
} finally {
  mod._malloc = malloc;
  mod._free(growthBlock);
  mod._free(p);
}
console.log(
  "groundwater: XY save/reopen, SI/US authoring, independent clock, velocity snapshots and heap growth OK",
);
