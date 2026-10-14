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
- Builds of every push are available as GitHub Actions artefacts on the
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
| `end()` | Finalise the simulation. |
| `report()` | Write the .rpt file. |
| `close()` | Release simulation resources. |
| `destroy()` | Free the engine context. |
| `run(inp, rpt, out, save?, plugin?)` | One-shot complete simulation. |
| `state` | `EngineState` — current lifecycle state. |
| `startDatetime` | `Date` — simulation start. |
| `endDatetime` | `Date` — simulation end. |
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

### Nodes / Node

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
| State | `getDepths()`, `getHeads()`, `getCouplingFluxes()`, `getRainfallBulk()`, `getRainVolumeBulk()`, `getCouplingVolumeBulk()`, `getEdgeFluxBulk()`, `getEdgeGeometryBulk()`, `getVertexHeads()`, `getVertexRenderDepths()` and the single-cell getters |
| Summary | `maxDepth`, `totalVolume`, `totalExchangeFlow`, `solverSteps`, `solverLastStep`, `runStats`, `continuityError`, `getMassBalance()`, `getStatMaxDepths()`, `getStatMaxVelocities()`, `getStatMaxContinuityErr()` |
| Forcing | `forceRainfall`, `forceRainfallUniform`, `forceEvap`, `forceEvapUniform`, `forceCouplingFlux` (options `{ mode, persist }`, default `OVERRIDE`/`RESET` as in Python), `forceClearAll()` |
| Infiltration | `surface2d.infiltration`: `infilStep`, `defaults`, `setDefault`, `cell`, `setCell`, `setCells`, `rate()`, `cumulative()`, `totalVolume` |

Notes:

- **Units.** The 2D solver runs in SI whatever the model's flow units: metres,
  m/s, m³ and m³/s.
- **No `.h5` results file.** The WASM build has no HDF5 writer, so
  `[2D_OPTIONS] OUTPUT_FILE` is ignored with a warning in the report; read
  results through `surface2d` (copy per call — keep the arrays you need).
- **Mesh groundwater, surface quality and groundwater transport** are built
  in and reachable through the raw layer (`swmm_gw2d_*`, `swmm_sq2d_*`,
  `swmm_gw_transport_*`); they have no TypeScript classes yet.
- **Size.** 2D adds about 0.6 MB to the `.wasm`. Configure with
  `-DOPENSWMM_WASM_2D=OFF` for a 1D-only module; the 2D raw functions then
  throw "export … is not available".

### Enumerations

All 78 enum classes are generated from the pinned engine’s
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
npm run smoke                 # end-to-end 1D (smoke.inp) and 2D (smoke2d.inp) runs against dist/
npm run check:bindings        # native signature checks against engine headers (no emsdk needed)
```

The engine is built with the 2D module (`-DOPENSWMM_WASM_2D=ON`) and GeoPackage
support (`-DOPENSWMM_WASM_GEOPACKAGE=ON`, SQLite compiled from the pinned
amalgamation). The 2D module is built without its HDF5 results writer
(`OPENSWMM_2D_HDF5_OUTPUT=OFF`), which needs an engine that has that option;
configure fails with a clear message on an older submodule. HDF5 `.h5` model
I/O and the GPU plugin are not part of the WASM build.

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

After cloning, initialise it with:

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
compilation. Generation against the pinned engine yields **1,244 C functions**
(1,048 without the 2D headers), **81 enum classes** and the six callback
typedefs with their `addFunction()` signatures; no header is excluded.
The sibling engine working tree can contain newer uncommitted APIs; those are
not automatically part of this package. Regenerate after deliberately advancing
the submodule, and rebuild the binary as well as TypeScript.

| Surface | Available | Remaining boundary |
|---|---|---|
| Raw C API | `bindRaw(mod)` / package `/raw`; signatures, export list and struct layouts generated from the engine headers | Heap allocation, pointer lifetimes, return codes and callback registration remain the caller’s responsibility. This is not the Python object API. |
| Enums | All numeric Python enum classes, including transport and capability selectors | Disabled-feature selectors are constants only. |
| Solver, builder and element views | Lifecycle, 1D collections, controls and forcing; destroyed owners and transferred builder owners reject view access | Mutations made through raw calls bypass wrapper invalidation. Reacquire views after such mutations. |
| ARD transport | `solver.transport` and `builder.transport`: configuration, conduit overrides, boundary/source snapshots | Persistence needs a process-component registration and config-file path. Capability matrices and other process services remain raw APIs. |
| Runtime forcing | Existing flow/rainfall controls plus `nodeTemperature`, `nodeAge`, `linkSeepage` | Use native field units: temperature REPLACE is °C, age REPLACE is hours; ADD uses °C·ft³/s or hours·ft³/s. Both require the corresponding model option. |
| 2D surface routing | `solver.surface2d` (`Surface2D`) and `surface2d.infiltration`, mirroring Python; all five 2D headers in the raw layer | No HDF5 results file (`OUTPUT_FILE` is ignored with a warning). Mesh groundwater, surface quality and groundwater transport are raw-only. |
| Catalog, generic field paths, Gymnasium specs and MCP tools | Python ecosystem facilities | No TypeScript catalog dispatcher or Gymnasium/MCP runtime is supplied. |
| Output, hot starts, metadata, batch edits and staged serialization | Available through raw exports for enabled features | Dedicated Python-style facade classes and automatic callback/error marshalling remain future work. |

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
python3 tools/check_python_parity.py
npm run check:bindings
npm run typecheck && npm test && npm run build
npm run configure:wasm && npm run build:wasm
npm run smoke
```

The parity check uses the engine’s Cython tokenizer: comments, strings and
extern declarations do not count as calls, while executable `.pxd` helpers do.
It fails when source files are missing. Raw API coverage, host signature checks,
TypeScript unit tests and a real WASM smoke run are separate checks; none alone
establishes numerical parity for every transport process. Browser execution,
worker integration, heap-allocation failure handling and complete high-level
Python API parity still require dedicated validation/work.
