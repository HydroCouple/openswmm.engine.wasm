# @hydrocouple/openswmm-engine-wasm

WebAssembly bindings for the **OpenSWMM Engine** C++ API, compiled with
[Emscripten](https://emscripten.org/) and exposed through a generated raw C API and a typed TypeScript convenience
layer. The raw layer covers the enabled native features; the convenience
classes cover a subset of the Python API. See [Compatibility and gaps](#compatibility-and-gaps).

[![Build & Type-Check](https://github.com/HydroCouple/openswmm.engine.wasm/actions/workflows/build.yml/badge.svg)](https://github.com/HydroCouple/openswmm.engine.wasm/actions/workflows/build.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

---

## Contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [Trivial 2D example](#trivial-2d-example)
- [API reference](#api-reference)
  - [Solver](#solver)
  - [Nodes / Node](#nodes--node)
  - [Links / Link](#links--link)
  - [Subcatchments / Subcatchment](#subcatchments--subcatchment)
  - [Gages / Gage](#gages--gage)
  - [Controls](#controls)
  - [Forcing](#forcing)
  - [Surface2D (2D surface routing)](#surface2d-2d-surface-routing)
  - [Coupling, native peers and flow tracing](#coupling-native-peers-and-flow-tracing)
  - [Fields by catalog path](#fields-by-catalog-path)
  - [Saved results](#saved-results)
  - [Tables, patterns, cross-sections and dates](#tables-patterns-cross-sections-and-dates)
  - [Enumerations](#enumerations)
  - [Error hierarchy](#error-hierarchy)
- [Building the WASM module](#building-the-wasm-module)
- [Releasing](#releasing)
- [Contributing](#contributing)
- [License](#license)

---

## Installation

```bash
npm install @hydrocouple/openswmm-engine-wasm
```

The published package carries the compiled module (`dist/openswmm_engine.wasm`
and its `.js` glue) as well as the TypeScript wrappers. Its version carries
the same qualifier as the `openswmm` Python package built from the same engine
(`6.0.0a4.dev2` on PyPI is `6.0.0-alpha.4.dev.2` here). Development builds are
published under the `dev` dist-tag, other pre-releases under `next`:

```bash
npm install @hydrocouple/openswmm-engine-wasm@dev    # matches openswmm 6.0.0a4.dev2
npm install @hydrocouple/openswmm-engine-wasm@next   # latest alpha/beta/rc
```

Other channels carry the same build:

- **GitHub Packages.** Add `@hydrocouple:registry=https://npm.pkg.github.com`
  to your `.npmrc` (GitHub requires an authenticated client with
  `read:packages`, even for public packages), then `npm install` as above.
- **Without a bundler.** Each
  [GitHub Release](https://github.com/HydroCouple/openswmm.engine.wasm/releases)
  carries `openswmm-engine-wasm-<version>-browser.zip` (the ES module glue,
  the `.wasm` and the compiled wrappers) and `SHA256SUMS`. The npm package is
  also served by CDNs, e.g.
  `https://cdn.jsdelivr.net/npm/@hydrocouple/openswmm-engine-wasm@next/dist/openswmm_engine.js`.
- Builds of every push are available as GitHub Actions artifacts on the
  [`build` workflow](https://github.com/HydroCouple/openswmm.engine.wasm/actions).

---

## Quick start

```ts
// 1. Load the Emscripten-generated WASM module
import createOpenSwmmModule from
  "@hydrocouple/openswmm-engine-wasm/wasm";

// 2. Import the TypeScript wrappers
import { Solver, EngineState, ForcingMode } from
  "@hydrocouple/openswmm-engine-wasm";

// 3. Create the module (asynchronous — WASM compilation)
const mod = await createOpenSwmmModule();

// 4. Create a Solver and upload the .inp file to the virtual filesystem
const solver = new Solver(mod);
solver.writeFile("/model.inp", inpFileBytes);   // Uint8Array or string

// 5. Full simulation lifecycle
solver.open("/model.inp", "/model.rpt", "/model.out");
solver.initialize();
solver.start(true /* save results */);

while (solver.step() > 0) {
  // Read node depths
  const depths = solver.nodes.depths;
  console.log("depths:", depths);

  // Inject a lateral inflow at runtime
  const j1 = solver.nodes.getIndex("J1");
  solver.forcing.nodeLatInflow(j1, 0.5, ForcingMode.REPLACE);
}

solver.end();
solver.report();
solver.close();

// 6. Read the report file back
const report = solver.readFile("/model.rpt", "utf8");
console.log(report);

// 7. Free the engine context
solver.destroy();
```

### One-shot run

```ts
solver.run("/model.inp", "/model.rpt", "/model.out");
const report = solver.readFile("/model.rpt", "utf8");
```

### `using` (TC39 Explicit Resource Management)

```ts
{
  await using solver = new Solver(mod);
  solver.writeFile("/model.inp", data);
  solver.run("/model.inp", "/model.rpt", "/model.out");
}  // solver.destroy() called automatically
```

---

## Trivial 2D example

The smallest useful 2D model: rain on a 100 m × 100 m plane, tilted 1 m
toward its south edge, meshed as **two triangles**, draining through that one
edge. There is no 1D network — the deck has only a rain gage, its timeseries
and the `[2D_*]` sections. It ships with the package as
[`examples/trivial_2d.inp`](examples/trivial_2d.inp) and a runnable script,
[`examples/trivial_2d.mjs`](examples/trivial_2d.mjs).

```ini
[RAINGAGES]
RG1     INTENSITY  0:05  1.0  TIMESERIES STORM

[TIMESERIES]
;; Each value lasts one gage interval (0:05): 30 minutes of 50 mm/hr = 25 mm.
STORM   0:00  50
STORM   0:05  50
STORM   0:10  50
STORM   0:15  50
STORM   0:20  50
STORM   0:25  50

[2D_VERTICES]
;;X     Y      Z (m)
0.0     0.0    0.0
100.0   0.0    0.0
100.0   100.0  1.0
0.0     100.0  1.0

[2D_TRIANGLES]
;;V1  V2  V3  Manning_n  Init_depth
0     1   2   0.03       0.0
0     2   3   0.03       0.0

[2D_BOUNDARY_CONDITIONS]
;; Edge e is opposite vertex e: triangle 0 edge 2 is (v0, v1), the low side.
0      2     NORMAL_FLOW  0.01     *        *
```

(The full file adds `[TITLE]`, `[OPTIONS]` for a two-hour run with a 5 s
routing step, and a two-line `[2D_OPTIONS]`.)

```ts
import { readFileSync } from "node:fs";
import createOpenSwmmModule from "@hydrocouple/openswmm-engine-wasm/wasm";
import { Solver } from "@hydrocouple/openswmm-engine-wasm";

const solver = new Solver(await createOpenSwmmModule());
solver.writeFile("/trivial_2d.inp",
  readFileSync("node_modules/@hydrocouple/openswmm-engine-wasm/examples/trivial_2d.inp", "utf8"));

solver.open("/trivial_2d.inp", "/trivial_2d.rpt", "/trivial_2d.out");
solver.initialize();                  // builds the 2D solver state
const mesh = solver.surface2d;        // 4 vertices, 2 triangles

solver.start();
let peak = 0;
while (solver.step() > 0) {
  peak = Math.max(peak, mesh.maxDepth);         // m
}
const balance = mesh.getMassBalance();          // m³ (2D is SI throughout)
solver.end();
solver.close();
solver.destroy();

console.log(peak, balance.rainfallIn, balance.boundaryOut, balance.continuityError);
```

From a clone, `node examples/trivial_2d.mjs` runs the same thing and prints:

```text
mesh: 4 vertices, 2 triangles
peak depth   0.0092 m
rainfall in  250.000 m³
edge outflow 243.606 m³
still stored 6.394 m³
continuity   8.19e-15 %
```

250 m³ is exactly 25 mm over 10 000 m²; the rest of the water is still on the
plane when the run ends. `npm run smoke` runs this script and fails if those
figures stop holding, so the example cannot drift from the engine. To grow it,
add triangles to `[2D_VERTICES]`/`[2D_TRIANGLES]`, more `[2D_BOUNDARY_CONDITIONS]`
edges, or couple 1D nodes with `[2D_VERTEX_NODE_MAP]` — the
[Surface2D](#surface2d-2d-surface-routing) reference covers the rest of the API.

---

## API reference

### Solver

The main lifecycle controller.

| Method / Property | Description |
|---|---|
| `new Solver(mod)` | Create an engine context. |
| `handle` | Opaque integer engine handle. |
| `writeFile(path, data)` | Upload a file to the virtual FS. |
| `readFile(path)` | Read a file from the virtual FS as `Uint8Array`. |
| `readFile(path, "utf8")` | Read a file as a UTF-8 string. |
| `setLenientOpen(on)` | Allow non-fatal parse errors. |
| `open(inp, rpt, out, pluginLib?)` | Parse the .inp file. |
| `initialize()` | Apply initial conditions. |
| `start(saveResults?)` | Prepare the solver for stepping. |
| `step()` | Advance by one routing step. Returns elapsed seconds (0 when done). |
| `stride(n)` | Advance by `n` routing steps. |
| `end()` | Finalize the simulation. |
| `report()` | Write the .rpt file. |
| `close()` | Release simulation resources. |
| `destroy()` | Free the engine context. |
| `run(inp, rpt, out, save?, plugin?)` | One-shot complete simulation. |
| `state` | `EngineState` — current lifecycle state. |
| `startDatetime`, `endDatetime`, `reportStartDatetime` | `Date` — configured `[OPTIONS]` dates (settable). |
| `simStartTime`, `simEndTime` | `Date` — the resolved start and end the engine runs. |
| `currentDatetime` | `Date` — current simulation time. |
| `routingStep` | Routing time step in seconds. |
| `flowUnits` | `FlowUnits` — unit system in use. |
| `lastErrorCode` | Last C API error code. |
| `lastErrorMessage` | Last C API error message string. |
| `nodes` | `Nodes` — node collection. |
| `links` | `Links` — link collection. |
| `subcatchments` | `Subcatchments` — subcatchment collection. |
| `gages` | `Gages` — rain gage collection. |
| `controls` | `Controls` — control rules. |
| `forcing` | `Forcing` — runtime forcing. |
| `transport` | `Transport` — ARD transport authoring. |
| `surface2d` | `Surface2D` — 2D surface routing (see below). |
| `options`, `userflags`, `events` | `[OPTIONS]`/`[OPTIONS_EXT]` by key, user flags, `[EVENTS]` periods. |
| `tables`, `patterns` | Time series, curves and patterns. |
| `openMetadata(inp)`, `openSimulationPeriod(inp)` | Partial opens for inspection and editing. |
| `advanceTo(s)`, `until(Date \| s)`, `steps()`, `elapsed` | Step to a time; iterate steps; elapsed seconds. |
| `write`, `writeWithPlugin`, `writeCompat`, `writeStaged` | Save the model (native, plugin, EPA SWMM 5, staged). |
| `setProgressCallback`, `setWarningCallback`, `setStepBeginCallback`, `setStepEndCallback`, `setPhaseCallback` | JavaScript callbacks; an error a callback throws is rethrown when the engine call returns. |
| `openErrors`, `openWarnings`, `crs`, `unitSystem`, `eventCount`, `isBetweenEvents`, `steadyStateSkip`, `generation` | Diagnostics and model facts. |
| `openRunoffInterfaceWrite/Read`, `saveRunoffStep`, `readRunoffStep`, `closeRunoffInterface` | Runoff interface files. |

Module functions: `run(mod, inp, rpt?, out?)`, `runWithCallback(mod, inp, rpt, out, cb)` and
`abiTag(mod)` mirror Python's `run`, `run_with_callback` and `abi_tag`.

### Nodes / Node

An ordinary junction's `storageArea` is writable before initialization, in
project ft²/m². Zero retains legacy behavior; a positive value supplies real
constant-area chamber storage through pipe surcharge up to the rim. It is
separate from surface ponding and the `MIN_SURFAREA` numerical stability setting.
Kinematic/steady routing refuses positive chamber areas; supported dynamic-wave
and qualified finite-volume paths retain them. Use EXTRAN, SLOT or TPA for
dynamic wave; DYNAMIC_SLOT refuses positive chambers. Finite-volume chambers
require the CPU backend and zero surcharge-depth allowance. If a dynamic-wave
chamber cannot close its water budget, the engine stops with guidance to reduce
`ROUTING_STEP` or increase `MAX_TRIALS`.

```ts
solver.open("/model.inp", "/model.rpt", "/model.out");
solver.nodes.get("J1").storageArea = 12.566; // ft² in a US-unit model
solver.fields.set("node.storage_area", "J1", 12.566); // same C API property
console.log(solver.nodes.get("J1").storageArea);
// Initialize/start only after geometry edits.
```

```ts
const nodes = solver.nodes;

nodes.length                  // number of nodes
nodes.get(0)                  // Node by index
nodes.get("J1")               // Node by string ID
nodes.getIndex("J1")          // index → -1 if not found
nodes.getId(0)                // string ID

// Bulk arrays (avoid per-node WASM overhead)
nodes.depths                  // Float64Array
nodes.heads                   // Float64Array
nodes.volumes                 // Float64Array
nodes.lateralInflows          // Float64Array
nodes.overflows               // Float64Array

// for…of iteration
for (const node of nodes) { … }
```

**`Node` properties:**

| Property | Type | Description |
|---|---|---|
| `id` | `string` | Node identifier. |
| `index` | `number` | Zero-based index. |
| `type` | `NodeType` | Junction / Outfall / Storage / Divider. |
| `depth` | `number` | Water depth (m or ft). Settable. |
| `head` | `number` | Hydraulic head. |
| `volume` | `number` | Stored volume. |
| `lateralInflow` | `number` | Lateral inflow rate. Settable. |
| `overflow` | `number` | Flooding rate. |
| `inflow` | `number` | Total inflow rate. |
| `losses` | `number` | Evap + exfiltration. |
| `outflow` | `number` | Total outflow rate. |
| `invertElev` | `number` | Invert elevation. Settable. |
| `maxDepth` | `number` | Maximum design depth. Settable. |
| `stats` | `NodeStats` | Accumulated statistics. |
| `setHeadBoundary(head)` | — | Impose fixed head (outfall nodes). |

### Links / Link

```ts
const links = solver.links;
links.length
links.get(0)        // by index
links.get("C1")     // by ID
links.flows         // Float64Array
links.depths        // Float64Array
links.velocities    // Float64Array
links.capacities    // Float64Array
```

**`Link` properties:**

| Property | Type | Description |
|---|---|---|
| `id` | `string` | Link identifier. |
| `index` | `number` | Zero-based index. |
| `type` | `LinkType` | Conduit / Pump / Orifice / Weir / Outlet. |
| `flow` | `number` | Flow rate. Settable. |
| `depth` | `number` | Water depth at upstream end. |
| `velocity` | `number` | Flow velocity. |
| `capacity` | `number` | Flow / full-pipe flow (0–1+). |
| `volume` | `number` | Stored volume. |
| `controlSetting` | `number` | Gate opening fraction (0–1). Settable. |
| `targetSetting` | `number` | Target gate opening. Settable. |
| `isClosed` | `boolean` | Whether the link is closed. Settable. |
| `fromNodeIndex` | `number` | Upstream node index. |
| `toNodeIndex` | `number` | Downstream node index. |

### Subcatchments / Subcatchment

```ts
for (const sc of solver.subcatchments) {
  console.log(sc.id, sc.runoff, sc.area);
}
```

### Gages / Gage

```ts
const gage = solver.gages.get("G1");
console.log(gage.rainfall, gage.rainType, gage.dataSource);
gage.scaleFactor = 1.1;
```

### Controls

```ts
const controls = solver.controls;
controls.length
controls.get(0)                     // → { id, text }
controls.addRule(ruleText)
controls.removeRule(index)
controls.clearRules()
controls.setLinkSetting(linkIdx, 0.5)   // gate fraction
controls.setLinkStatus(linkIdx, 1)      // 1=on, 0=off
```

### Forcing

```ts
const f = solver.forcing;
const j1 = solver.nodes.getIndex("J1");
const c1 = solver.links.getIndex("C1");
const g1 = solver.gages.getIndex("G1");
const s1 = solver.subcatchments.getIndex("S1");

import { ForcingMode, ForcingTarget } from "@hydrocouple/openswmm-engine-wasm";

f.nodeLatInflow(j1, 0.5, ForcingMode.REPLACE);    // override node lateral inflow
f.nodeHeadBoundary(j1, 10.0, ForcingMode.REPLACE); // override outfall head
f.linkFlow(c1, 0.3, ForcingMode.ADD);              // add to link flow
f.linkSetting(c1, 0.8, ForcingMode.REPLACE);       // override gate setting
f.subcatchRainfall(s1, 5.0, ForcingMode.REPLACE);  // override subcatchment rainfall
f.gageRainfall(g1, 10.0, ForcingMode.REPLACE);     // override gage rainfall

f.clear(ForcingTarget.NODE, j1);    // clear forcing for a specific object
f.clearAll();                        // clear all forcing
```

### Surface2D (2D surface routing)

`solver.surface2d` mirrors Python's `Solver.surface2d`: the same methods in
camelCase (`get_depths()` → `getDepths()`, `n_triangles` → `nTriangles`). It
is active once the model has a 2D mesh (`[2D_VERTICES]`/`[2D_TRIANGLES]` or
`[2D_MESH_FILE]`) and `initialize()` has run.

```ts
solver.open("/model.inp", "/model.rpt", "/model.out");
solver.initialize();
const mesh = solver.surface2d;

if (mesh.isActive) {
  const { x, y, z } = mesh.getVertexCoords();      // Float64Array, metres
  const cells = mesh.nTriangles;                   // triangles + quads
  mesh.setTriangleMannings(0, 0.02);

  solver.start();
  while (solver.step() > 0) {
    const depth = mesh.getDepths();                // one value per cell (m)
    const flux = mesh.getEdgeFluxBulk();           // cells x edgeStride (m²/s)
    mesh.forceRainfallUniform(1e-5);               // m/s, this step only
  }
  console.log(mesh.getMassBalance(), mesh.runStats);
  console.log(mesh.infiltration.totalVolume);      // m³
}
```

| Group | Members |
|---|---|
| Mesh | `isActive`, `nVertices`, `nTriangles`/`nCells`, `nQuads`, `edgeStride`, `getVertexCoords()`, `getVertexXyz(i)`, `getCellVertices(i)`, `getCellNeighbours(i)`, `getTriangleVertices(i)`, `getTriangleNeighbours(i)`, `getTriangleArea(i)`, `getTriangleCentroid(i)` |
| Editing (before `initialize()`) | `setVertexZ`, `setVertexZBulk`, Manning's `n`, initial depth and velocity, vertex/triangle tags, couplings, boundary conditions, edge conveyance, `prepareForEdit()` |
| State | `getDepths()`, `getHeads()`, `getVelocities()` (independent X/Y arrays in m/s), `getCouplingFluxes()`, `getRainfallBulk()`, `getRainVolumeBulk()`, `getCouplingVolumeBulk()`, `getEdgeFluxBulk()`, `getEdgeGeometryBulk()`, `getVertexHeads()`, `getVertexRenderDepths()` and the single-cell getters |
| Summary | `maxDepth`, `totalVolume`, `totalExchangeFlow`, `solverSteps`, `solverLastStep`, `runStats`, `continuityError`, `getMassBalance()`, `getStatMaxDepths()`, `getStatMaxVelocities()`, `getStatMaxContinuityErr()` |
| Forcing | `forceRainfall`, `forceRainfallUniform`, `forceEvap`, `forceEvapUniform`, `forceCouplingFlux` (options `{ mode, persist }`, default `OVERRIDE`/`RESET` as in Python), `forceClearAll()` |
| Infiltration | `surface2d.infiltration`: `infilStep`, `defaults` (a live `Infil2DDefaults` mapping), `setDefault`, `cell`, `setCell`, `setCells`, `authoredRows`/`replaceAuthoredRows`, `ownership`/`ownershipBulk`, `rate()`, `cumulative()`, `totalVolume` |
| Quality and edges | `species`, `concentrations(i)`, initial, initial-bed and boundary quality rows, `setEdgeBcConcentrations`, `clearEdgeBc`/`clearBoundary`, `boundaryFlow`, `edgeIsExterior`, `setEdgeBcGroup`, wall drag, initial HGL |
| Coupling, owners, output | node coupling type/parameters (`validateNodeCoupling`, `replaceNodeCoupling`, ...), surface owners (`getSurfaceOwners`, `previewSurfaceOwners`, `replaceSurfaceOwners`), `setResultsFile`, `setAutoBackendCpu`, `geometryScaleToSi`, `getReportRainfallBulk`, and the `snow` and `quality` sub-views |
| Runtime exchange | `sources` (a `DomainSources`), `setWaterSource`, `setHeatSource`, `setSpeciesSource`, `clearSource`, `sourceReceipt`, `setHeadBoundary`, `setFlowBoundary`, `boundaryReceipt`, `speciesLedger`; see [Coupling](#coupling-native-peers-and-flow-tracing) |

Notes:

- **Units.** The 2D solver runs in SI whatever the model's flow units: meters,
  m/s, m³ and m³/s.
- **Results file.** `[2D_OPTIONS] OUTPUT_FILE` is written to the virtual
  filesystem as CF/UGRID HDF5, uncompressed like the native engine's, so native
  readers (`Output2DReader` in Python) open it; copy it out with
  `solver.readFile`. Live results come from `surface2d` (copy per call — keep
  the arrays you need).
- **Groundwater** is available as `surface2d.groundwater` (also
  `solver.groundwater2d`): `options` (`AquiferOptions`, with
  `setProcessOptions`), aquifer rows, node and link beds (`replaceNodes` for
  compare-and-replace), authored boundaries and their receipts, species,
  concentrations, layer quality, species ledgers, execution status, live SI
  cell arrays, tier histograms and `clockStats`. Its `transport` view covers
  parameters, sorption, initial quality, boundary quality, named and XY
  sources with scale and species terms, and the initial-quality file. Clock
  counters use `bigint` to preserve 64-bit values. Runtime sources and
  boundaries (`sources`, `setWaterSource`, `setHeadBoundary`,
  `boundaryFlow`, ...) match the surface's; surface quality is
  `surface2d.quality`.
- **Size.** 2D adds about 0.6 MB to the `.wasm`. Configure with
  `-DOPENSWMM_WASM_2D=OFF` for a 1D-only module; the 2D raw functions then
  throw "export … is not available".

### Coupling, native peers and flow tracing

```ts
import { FlowTracer, NodeType, TraceTerminal } from "@hydrocouple/openswmm-engine-wasm";

const s = solver.surface2d; // after initialize() and start()
s.setWaterSource([0, 1], [0.01, 0.02], { concentrations: { TSS: 7 } }); // m³/s per cell
solver.advanceTo(60);
console.log(s.sourceReceipt("external", 0).appliedM3, s.speciesLedger("TSS").externalIn);

// One provider's sources, boundaries and forcing, applied atomically:
solver.coupling.forProvider("model-b").applyFrame({
  sources: [{ sourceId: "inflow", domain: "groundwater", cell: 0, flowM3S: 0.001 }],
  forcings: [{ channel: "rainfall", rateMS: 1e-5, untilSeconds: 600 }],
});

// Flow tracing over a saved output, independent of any solver:
using trace = new FlowTracer(mod, [{ id: "J1" }, { id: "O1", type: NodeType.OUTFALL }],
  [{ id: "C1", fromNode: 0, toNode: 1, lengthM: 100 }]);
trace.prepare("/model.out");
console.log(trace.estimate("J1").summary.terminal[TraceTerminal.OUTFALL]);
```

| Class | Members |
|---|---|
| `Coupling` (`solver.coupling`) | `providerId`, `forProvider`, `surface`, `groundwater`, `capabilities`, `setSources`, `applyFrame`, `advanceTo` |
| `DomainSources` | `waterTotals`, `setSource`, `clearSource`, `sourceReceipt`, `sourceReceipts`, `setBoundary`, `clearBoundary`, `boundaryFlow`, `setBoundaries`, `setForcings`, `boundaryReceipt`, `infiltrationReceipt`, `speciesLedger` |
| `SplitParticipant` (`solver.split`), `SplitFrame` | `validateInput`, `configure`, `geometry`, `applyGeometry`, `setCallback`, `evaluate`, `encode`, `decode`; frames: `phase`, `time`, `node`, `source`, `outfallReturn`, `close` |
| `MaterialSplitParticipant` (`solver.materialSplit`) | the above plus `setTransport`, `bind`, `copyPacket` and the `checkpoint*` pair recovery |
| `PassiveExchange` (`solver.passiveExchange`) | `enable`, `enableCheckpoint`, `status`, `pool`, `receipt`, `row`, `leg`, `attempt` |
| `FlowTracer` | `defaultOptions(mod)`, `nodeIds`, `linkIds`, `topology`, `info`, `averages`, `setAverages`, `prepare`, `prepareLive`, `estimate`, `close`; failures raise `TraceError` with a `TraceStatus` code |

Records are plain objects with camelCase keys (`appliedM3`, `flowM3S`,
`rateMS`). Split frames and tracers own native memory: close them, or use
them with `using`. Receipt, row and leg IDs of the passive exchange take a
safe integer or a `bigint`. Inspection and lifecycle calls from inside a
callback are refused with `LifecycleError`, as in Python.

### Fields by catalog path

`solver.fields` reads and writes engine fields by the same dotted paths the
Python catalog (`openswmm.engine.catalog`), the MCP server and the gymnasium
environments use. It covers every catalog property backed by a single C
getter (and setter); `paths()` lists them and `describe(path)` gives the C
functions, type and unit kind.

```ts
solver.fields.get("node.max_depth", "J1");          // by id or index
solver.fields.set("link.roughness", "C1", 0.012);
solver.fields.getAll("node.depth");                   // one value per node
solver.fields.get("climate.elevation");               // services take no element
solver.fields.describe("link.flow").units;            // "flow": the model's flow units
```

Values are in the model's units; enum fields return their number and Boolean
fields `true`/`false`. Engine refusals keep their typed errors (for example a
runtime-only field written while the model is only opened raises
`LifecycleError`).

### Saved results

`solver.openResults()` (after `end()`) opens the run's `.out` and, when the
model sets `[2D_OPTIONS] OUTPUT_FILE`, its 2D HDF5 file. Fields are lazy: they
describe a variable (units, named dimensions, shape, times) and load values on
`read()`, as a row-major `NDArray` (`{ shape, data }`). Selectors take ids,
indices, `slice(start, stop, step)` or lists, as in Python.

```ts
solver.end();
using results = solver.openResults();
const depth = results.nodes!.variables.get("depth")!;   // dimensions ["time", "object"]
depth.read({ objects: ["J1", "J2"], periods: slice(0, 12) }); // shape [12, 2]
results.nodes!.get("J1").variables.get("depth")!.read();      // one node's history
const surf = results.surface!.variables.get("depth")!;   // /Mesh2_face_depth
surf.read({ periods: -1 });                              // last report, every cell
results.surface!.mesh;                                   // vertices, cells, vertexCounts
```

`OutputReader` and `Output2DReader` read the files directly, also files copied
into the module's file system from elsewhere: `new OutputReader(mod, "/model.out")`.

### Tables, patterns, cross-sections and dates

`solver.tables` holds the time series and curves (one namespace, by index or
id) and `solver.patterns` the `[PATTERNS]` entries, as in Python. Create them
after `open()` and before `initialize()`.

```ts
const ts = solver.tables.addTimeseries("Inflow");
ts.add(new Date(Date.UTC(2026, 0, 1, 6)), 4.2);     // UTC wall clock
solver.tables.asTimeseries("TS1").points;           // [Date, value][]
const curve = solver.tables.addCurve("Rating");
curve.replacePoints([[0, 0], [2, 10]]);
curve.lookup(1);                                    // 5, the engine's interpolation
solver.patterns.add("Monthly", PatternType.MONTHLY).setFactors(new Array(12).fill(1));
```

`XSectionGeometry` runs the engine's cross-section kernels without a model, or
copies a link's geometry (`XSectionGeometry.fromLink(solver.links.get("C1"))`).
Every query takes a number or an array. It owns a native handle: `destroy()` it
or use `using`.

```ts
using pipe = new XSectionGeometry(mod, XSectShape.CIRCULAR, 1, { units: "SI" });
pipe.area(0.5);                     // m²
pipe.area([0.1, 0.5, 0.9]);         // Float64Array, one C call
```

SWMM DateTimes are days since 1899-12-30. `oadateToDatetime` /
`datetimeToOadate` convert to and from `Date` (UTC, to the millisecond);
`encodeDate`, `decodeTime`, `addSeconds`, `timeDiff`, ... call the engine and
take the module first: `encodeDate(mod, 2026, 11, 17)`.

### Enumerations

All 97 enum classes are generated from the pinned engine’s
`openswmm.engine._enums.py`, without importing native Python modules. Enum
constants for disabled features do not imply that those features are available.

| Enum | Key values |
|---|---|
| `ErrorCode` | `OK=0`, `BADHANDLE=7`, `BADINDEX=8`, … `INTERNAL=99` |
| `EngineState` | `NONE` … `BUILDING` (0–8) |
| `NodeType` | `JUNCTION=0`, `OUTFALL=1`, `STORAGE=2`, `DIVIDER=3` |
| `LinkType` | `CONDUIT=0` … `OUTLET=4` |
| `FlowUnits` | `CFS=0` … `MLD=5` |
| `RouteModel` | `STEADY=0`, `KINWAVE=1`, `DYNWAVE=2` |
| `ForcingMode` | `REPLACE=1`, `ADD=2` |
| `ForcingTarget` | `NODE=0` … `CLIMATE=4` |
| `XSectShape` | `CIRCULAR=0` … `DUMMY=25` |
| `GageDataSource` | `TIMESERIES=0`, `FILE=1` |
| `GageRainType` | `INTENSITY=0`, `VOLUME=1`, `CUMULATIVE=2` |
| `InfilModel` | `HORTON=0` … `CURVE_NUMBER=4` |
| `StorageShape` | `TABULAR=0` … `PYRAMIDAL=5` |
| `OutfallType` | `FREE=0` … `TIMESERIES=4` |
| `OrificeType` | `SIDE=0`, `BOTTOM=1` |
| `WeirType` | `TRANSVERSE=0` … `ROADWAY=4` |

### Error hierarchy

```
EngineError (base — code, codeEnum, message)
├── BadHandleError      SWMM_ERR_BADHANDLE (7)
├── BadIndexError       SWMM_ERR_BADINDEX  (8)
│   └── ElementNotFoundError   (string ID not found)
├── BadParamError       SWMM_ERR_BADPARAM  (9)
├── LifecycleError      SWMM_ERR_LIFECYCLE (6)
│   └── StaleObjectError       (wrapper outlived a model re-open)
├── HotStartError       SWMM_ERR_HOTSTART  (12)
├── PluginError         SWMM_ERR_PLUGIN    (10)
├── FileError           SWMM_ERR_INPFILE/RPTFILE/OUTFILE/IO
├── ParseError          SWMM_ERR_PARSE     (5)
├── NumericalError      SWMM_ERR_NUMERICAL (14)
├── CRSError            SWMM_ERR_CRS       (13)
└── DependencyError     SWMM_ERR_DEPENDENCY(15)
```

---

## Building the WASM module

### Prerequisites

- [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html) ≥ 3.1.0
- CMake ≥ 3.21
- Git (for submodules)

### Steps

```bash
# 1. Clone with submodules
git clone --recurse-submodules https://github.com/HydroCouple/openswmm.engine.wasm.git
cd openswmm.engine.wasm

# 2. Configure with the Emscripten toolchain
npm run configure:wasm        # = emcmake cmake -B build -DCMAKE_BUILD_TYPE=Release

# 3. Build (engine incl. 2D + GeoPackage/SQLite + bindings)
npm run build:wasm            # = cmake --build build --parallel

# 4. Outputs land in dist/
ls dist/
# openswmm_engine.js   openswmm_engine.wasm

# 5. Build TypeScript wrappers and run the checks
npm ci
npm run build
npm test                      # unit tests (mock module, no WASM needed)
npm run smoke                 # native exports, 1D, rain/snow save/reopen, 2D and HDF5 runs
npm run check:bindings        # native signature checks against engine headers (no emsdk needed)
```

The engine is built with the 2D module (`-DOPENSWMM_WASM_2D=ON`) and GeoPackage
support (`-DOPENSWMM_WASM_GEOPACKAGE=ON`, SQLite compiled from the pinned
amalgamation). HDF5 2.1.1, the native engine's vcpkg release, is downloaded
(SHA-512 checked) and built during configure (`-DOPENSWMM_WASM_HDF5=ON`, once
per build directory; about 3.3 MB of `.wasm`). It gives the 2D results file,
`.h5` model I/O and HDF5 checkpoints. Like the native vcpkg build it has no
zlib or szip, so files are written uncompressed and native builds can read
them. Reopen an `.h5` model by naming its input plugin:
`solver.open(path, rpt, out, "org.hydrocouple.openswmm.plugins.hdf5")`
(without it the built-in `.inp` reader is used). `-DOPENSWMM_WASM_HDF5=OFF` leaves
HDF5 out (`OUTPUT_FILE` is then ignored with a warning). The GPU plugin is not
part of the WASM build.

The npm package then ships:

```
dist/
├── openswmm_engine.js      Emscripten JS glue (factory function)
├── openswmm_engine.wasm    Compiled WASM binary
├── index.js                TypeScript wrappers (compiled)
├── index.d.ts              TypeScript declarations
└── ...
```

---

## Releasing

Pushing a tag `v<version>` runs [`release.yml`](.github/workflows/release.yml):
it checks that the tag matches `package.json` and that the version tracks the
pinned engine's Python bindings (`tools/check_version.py`), builds the
module in the pinned `emscripten/emsdk` image, runs the generated-binding,
struct-layout, lint, unit and 1D/2D smoke checks, then creates the GitHub
Release (tarball, browser zip, `SHA256SUMS`) and publishes the tarball to npm
and GitHub Packages — under `dev` for dev-qualified versions, `next` for other
pre-releases, otherwise `latest`.
Run the workflow by hand with *Dry run* checked to rehearse a release.

The rules, the release steps and the one-time npm/GitHub setup (environment
`npm`, `NPM_TOKEN` bootstrap, trusted publishing) are in
[RELEASING.md](RELEASING.md); changes are listed in [CHANGELOG.md](CHANGELOG.md).

---

## Submodule

The OpenSWMM Engine C++ source is included as a git submodule:

```
extern/openswmm.engine/   →  github.com/HydroCouple/openswmm.engine  (branch: swmm6_rel)
```

After cloning, initialize it with:

```bash
git submodule update --init --recursive
```

---

## Contributing

1. Fork the repository.
2. Create a feature branch: `git checkout -b feature/my-feature`.
3. Make changes and add tests in `tests/`.
4. Run `npm run typecheck && npm test`.
5. Open a pull request.

---

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the
full text and [NOTICE](NOTICE) for required attributions.

Copyright © 2026 HydroCouple Foundation. The HydroCouple Foundation has not yet
been formed; until it is, the copyright is held by Caleb Buahin (cbuahin), its
Executive Director. See [NOTICE](NOTICE).

See also: [CLA.md](CLA.md) · [CCLA.md](CCLA.md)


## Compatibility and gaps

The engine submodule is the reproducible source of truth for generation and
compilation. Generation against the pinned engine yields **1,535 C functions**
(1,272 without the 2D headers), **97 enum classes** and the fourteen callback
typedefs (`openswmm_callbacks.h` and those next to the API that takes them)
with their `addFunction()` signatures; no header is excluded.
The sibling engine working tree can contain newer uncommitted APIs; those are
not automatically part of this package. Regenerate after deliberately advancing
the submodule, and rebuild the binary as well as TypeScript.

| Surface | Available | Remaining boundary |
|---|---|---|
| Raw C API | `bindRaw(mod)` / package `/raw`; signatures, export list and struct layouts generated from the engine headers; 64-bit integers passed by value are `bigint`, and strings over 16,384 characters are copied to the heap rather than the 1 MB stack | Heap allocation, pointer lifetimes, return codes and callback registration remain the caller’s responsibility. This is not the Python object API. |
| Enums | All numeric Python enum classes, including transport and capability selectors | Disabled-feature selectors are constants only. |
| Solver, builder and element views | Lifecycle, options, user flags, events and callbacks; nodes, links, subcatchments and gages with their sub-views (storage, outfall, divider, xsect, pump, weir, orifice, outlet, infiltration, coverage, loadings, stats), aquifers, snowpacks, snow, tables, patterns, controls and forcing, `solver.spatial` (coordinates, polylines, polygons, `[MAP]`, CRS) and `solver.editor` / `ModelEditor` (deletes with impact reports and undo records, type conversion, conduit split and fuse), `solver.infrastructure` (transects, streets, inlet designs and placements, LID controls, storage-node LID stacks and subcatchment placements), member for member with Python (`tests/_work/python_parity_report.json`); destroyed owners and transferred builder owners reject view access | Mutations made through raw calls bypass wrapper invalidation. Reacquire views after such mutations. |
| ARD transport | `solver.transport` and `builder.transport`: configuration, conduit overrides, boundary/source rows, detailed output, `previewMatrix`; `solver.transportMatrix`, `threadInfo`, `effectiveThreads()` | Persistence needs a process-component registration and config-file path. Boundary and source rows need a configured species. |
| Runtime forcing | Existing flow/rainfall controls plus `nodeTemperature`, `nodeAge`, `linkSeepage` | Use native field units: temperature REPLACE is °C, age REPLACE is hours; ADD uses °C·ft³/s or hours·ft³/s. Both require the corresponding model option. |
| 2D surface routing | `solver.surface2d` (`Surface2D`) and `surface2d.infiltration`, mirroring Python; all five 2D headers in the raw layer; the `OUTPUT_FILE` results file through `Output2DReader` and `Results.surface` | Runtime sources are total SI m³/s per cell; the FULL_SWE momentum equation reports no runtime capabilities (`coupling.capabilities`) and refuses them. |
| Heat | `solver.heat`: flux modules, radiative, solar, cloud and sediment parameters, inlet temperatures with node and element overrides, effective values, mesh/ground/channel-ground status and values, channel-ground map preview (with progress), `HeatSnapshot` and `editAtomic` | Values the deck parser refuses are refused, never clamped. |
| Reactions | `solver.reactions`: species, coefficients and terms (live views), PIPE/TANK expressions, initial quality rows, `[REACTION_OPTIONS]`, `validate`, and the `.rxn` text round trip (`serialize`, `checkText`, `applyText`, `save`); `Reactions.hydraulicVariables(mod)` and `Reactions.functions(mod)` need no model | Edits are BUILDING/OPENED only; a mutation that leaves any expression uncompilable is rolled back and refused. |
| Build and process services | `capabilities(mod)` (the same JSON document as Python's `capabilities()`), `VERSION`, `solver.processComponents` (registrations, arguments, the known vocabulary), `solver.waterAge` (global ages, node overrides, `save`), `surface2d.snow` (mesh snow configuration, rows, states, ledgers) and `surface2d.quality` (coverages, loadings, curb lengths, buildup) | HydroCouple component libraries are not available in WASM: `ProcessComponents.libraries` is empty and `addSearchPath` throws. |
| Catalog | `catalog` (Python `openswmm.engine.catalog`: `lookup`, `members`, `targets`, `resolve`, `canonical`, `unitLabel`, revisions), embedded from the engine's `catalog.json` | Paths stay the Python names; `resolve` walks them on a TypeScript solver in camelCase. Targets of facade waves not yet shipped do not resolve. |
| Catalog field paths | `solver.fields`: 182 of 393 catalog properties by path (`"node.max_depth"`, `"link.stats.max_flow"`, `"climate.elevation"`), generated by `tools/gen_fields.py` and checked against the native engine by `tools/verify_fields_native.py`; coverage per target in `tests/fixtures/facade_coverage.json` | Properties that need unit conversion, tuples or records, and all methods, stay hand-written. No Gymnasium/MCP runtime is supplied. |
| Simulation services and results | Pollutants, quality, inflows, climate, statistics, mass balance, report snapshot, hot starts, the save schedule and checkpoint sessions; `OutputReader`, `Output2DReader` and `Results` for saved results; `GeoPackage` and `solver.writeGeopackage()`, mirroring Python | Checkpoints are saved only to new destinations (an existing file or folder is never replaced). Bundle export needs a file-backed checkpoint (a `FILES` session). |
| Coupling family | `solver.coupling` (`Coupling`, `DomainSources`: sources, boundaries, forcing, provider frames, receipts, species ledger), `solver.split` (`SplitParticipant`, `SplitFrame`: two peers in one module), `solver.passiveExchange` (V1 snapshots), `solver.materialSplit` and `FlowTracer` (with its HDF5 cache), mirroring Python | The material peer and the split packet codec need an engine built with HydroCouple: in WASM they raise `PluginError`. |

```ts
import { TransportDispersionMode } from "@hydrocouple/openswmm-engine-wasm";

const transport = solver.transport; // open the solver before authoring
transport.dispersionMode = TransportDispersionMode.VALUE;
transport.dispersionValue = 0.25; // ft²/s or m²/s, according to the model
transport.targetDx = 2;          // ft or m
console.log(transport.boundaries); // independent snapshots
```

`destroy()` is idempotent. Element views are invalidated on close/open;
builder views are invalidated on structural edits or ownership transfer.
Views obtained directly from numeric handles without an owner callback and all
raw API handles remain caller-managed. This package is single-threaded WASM;
the Python native-access lock is not a browser-worker sharing contract.

### Checks when updating the engine

```bash
npm run gen
python3 tools/gen_bindings.py --check
python3 tools/gen_fields.py --check
python3 tools/verify_fields_native.py <model.inp> ...   # with a native openswmm of the same engine
python3 tools/check_python_parity.py
python3 tools/gen_python_surface.py --check
npm run check:bindings
npm run typecheck && npm test && npm run build
npm run configure:wasm && npm run build:wasm
npm run smoke
npx vitest run tests/wasm      # real-module tests; skipped while dist/ lacks a build
```

The parity check uses the engine’s Cython tokenizer: comments, strings and
extern declarations do not count as calls, while executable `.pxd` helpers do.
It fails when source files are missing. Raw API coverage, host signature checks,
TypeScript unit tests and a real WASM smoke run are separate checks; none alone
establishes numerical parity for every transport process. Browser execution,
worker integration and broader heap-allocation failure handling still require
dedicated validation/work.

The high-level API is tracked against the Python bindings member by member:
`tools/gen_python_surface.py` writes the pinned engine's public Python surface
to `tests/fixtures/python_surface.json`, and `tests/python_surface.test.ts`
requires a TypeScript counterpart (camelCase) for every entry of each module that
`tools/python_surface_map.json` neither excludes (with a reason) nor lists as
pending. Each run writes per-module coverage, pending modules included, to
`tests/_work/python_parity_report.json`. Nothing is pending: every one of the
2,484 Python members has a TypeScript counterpart or a recorded exclusion.

### Groundwater clock and source authoring

```ts
const gw = solver.surface2d.groundwater; // after open(), before initialize()
gw.options.set("GW_CLOCK", "INDEPENDENT");
gw.options.set("GW_MAX_STEP", 4);
gw.transport.setSourceXy(0, 15, 2); // project map coordinates
// After start() and some steps:
const stats = gw.clockStats;
console.log(stats.closures.CLOSED_FORM?.firings); // bigint, exact 64-bit count
const [vx, vy] = solver.surface2d.getVelocities(); // SI m/s snapshots
```

Velocity snapshots preserve the engine's dry-cell zeros and paired NaNs for
indeterminate wet cells. Aquifer rows retain authored project units; live
groundwater state uses SI. Numeric and string allocation helpers reject failed
allocations before accessing the heap.
