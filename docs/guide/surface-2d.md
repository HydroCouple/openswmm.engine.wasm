# The 2D surface

`solver.surface2d` (`Surface2D`) follows Python's `Solver.surface2d`. It is active once the model
has a 2D mesh (`[2D_VERTICES]` and `[2D_TRIANGLES]`, optionally `[2D_QUADS]`, or
`[2D_MESH_FILE]`) and `initialize()` has run; `surface2d.isActive` tells.

- **SI units.** The 2D solver works in meters, m/s, m³ and m³/s whatever the model's flow units,
  and so do all `Surface2D` values.
- **Cells.** `nCells` (also `nTriangles`) counts triangles and quads; every per-cell array has
  that length.
- **Edits before `initialize()`.** Vertex elevations, Manning's *n*, initial depth and velocity,
  tags, couplings and boundary conditions are set after `open()` and before `initialize()`.
- **Copies.** State getters (`getDepths()`, `getHeads()`, `getVelocities()`, edge fluxes, ...)
  return new arrays on every call.
- **Forcing.** `forceRainfall`, `forceRainfallUniform`, `forceEvap`, `forceEvapUniform` and
  `forceCouplingFlux` take SI rates and the options `{ mode, persist }`; by default the value
  replaces the engine's for the next step only, as in Python.

```{literalinclude} ../examples/surface2d.mjs
:language: js
```

`node docs/examples/surface2d.mjs` prints (after the engine's backend notice on standard error):

```text
active true: 4 vertices, 2 cells
vertex 2: 100 100 1 | cell 0 area: 5000 m²
Manning's n: 0.03 0.05
depths at 15 min (m): [ '0.00884', '0.00380' ]
velocity of cell 0 (m/s): 0.0019 -0.0052
rain in 250.306 m³, out 248.636 m³
continuity error 9.08e-13 %
```

The forced step replaced the deck's 50 mm/h on both cells for 5 seconds, which adds 0.306 m³ to
the 250 m³ of the storm.

## The results file

With `[2D_OPTIONS] OUTPUT_FILE`, the engine writes the 2D results as CF/UGRID HDF5 to the module's
file system. The file is uncompressed, like the native engine's, so native readers
(`Output2DReader` in Python) open it. Read it with `solver.openResults()` or `Output2DReader`
({doc}`results`), or copy it out with `solver.readFile`. Without HDF5 in the build
(`-DOPENSWMM_WASM_HDF5=OFF`) the option is ignored with a warning.

## More of the surface

`Surface2D` also covers infiltration (`surface2d.infiltration`), surface quality
(`surface2d.quality`), mesh snow (`surface2d.snow`), groundwater (`surface2d.groundwater`, also
`solver.groundwater2d`), node coupling, surface owners, and runtime sources and boundaries
(`surface2d.sources`, `setWaterSource`, `setHeadBoundary`, ...), which the coupling family in
`solver.coupling` builds on. The {doc}`../api/index` lists them; the
[engine's Python guide](https://www.hydrocouple.org/openswmm.engine/python/) describes the same
members in snake_case.

With the FULL_SWE momentum equation the surface reports no runtime capabilities
(`solver.coupling.capabilities`) and refuses runtime sources.

## The WebGPU marcher

The published module runs the 2D surface on the CPU marcher. A build with
`-DOPENSWMM_WASM_WEBGPU=ON` ({doc}`../development/building`), which also needs the threads build,
carries the engine's WebGPU marcher. It is opt-in per model: `[2D_OPTIONS] BACKEND WEBGPU` selects
it, the `OPENSWMM_2D_BACKEND` environment variable overrides the model's choice, and `AUTO` never
chooses it. It runs in a browser that offers WebGPU (`navigator.gpu`) on a cross-origin-isolated
page, and computes the dynamics in 32-bit floats where the CPU marcher uses 64-bit.

When it cannot serve a model, the engine says why on standard error and runs the CPU marcher.
`solver.surface2d.runStats.backend` names the marcher that ran:

| Situation | `runStats.backend` |
| --- | --- |
| The WebGPU marcher runs the model | `webgpu` |
| The model uses an option the WebGPU marcher does not implement | `cpu (explicit marcher; WebGPU not applicable)` |
| No WebGPU device: Node.js, or a browser without WebGPU | `cpu (explicit marcher; no WebGPU device)` |
| A build without `OPENSWMM_WASM_WEBGPU` | `cpu (explicit marcher; WebGPU not in this build)` |

## Builds without 2D

`-DOPENSWMM_WASM_2D=OFF` builds a module without the 2D headers' functions; it is about 0.6 MB
smaller. The raw layer still lists those functions, and calling one throws
"export ... is not available".
