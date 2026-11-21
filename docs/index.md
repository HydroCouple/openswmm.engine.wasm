# OpenSWMM Engine for WebAssembly

`@hydrocouple/openswmm-engine-wasm` is the OpenSWMM Engine, developed by HydroCouple
([openswmm.engine](https://github.com/HydroCouple/openswmm.engine)), compiled to WebAssembly
with [Emscripten](https://emscripten.org/). It has two layers:

- a **raw layer**, generated from the engine's C headers: every exported C function (1,535 in
  this build) with its JavaScript types;
- **TypeScript classes** over that layer that follow the engine's Python API, member for member,
  with camelCase names: `Solver`, `Nodes`, `Links`, `Surface2D`, `Results` and the rest.

The same package runs in Node.js and, as an ES module, in a browser. The engine reads and writes
files in the module's in-memory file system, so a model is uploaded as text or bytes and its report
and results are read back the same way.

::::{grid} 1 2 2 2
:gutter: 3

:::{grid-item-card} Getting started
:link: getting-started/index
:link-type: doc

Install the package, run a 1D model step by step, and run the trivial 2D example in Node.js or
a browser.
:::

:::{grid-item-card} User guide
:link: guide/index
:link-type: doc

How the package is built and what each part does: the run lifecycle, model data, forcing and
controls, the 2D surface, saved results, errors and the raw layer.
:::

:::{grid-item-card} API reference
:link: api/index
:link-type: doc

Every exported class, interface, enumeration and function, generated from the TypeScript sources
with TypeDoc.
:::

:::{grid-item-card} Development
:link: development/index
:link-type: doc

Build the WebAssembly module from source, run the checks, regenerate the bindings and build this
manual.
:::
::::

## What this build includes

- The 1D engine as in the native build: hydrology, hydraulics, water quality, transport, heat,
  snow and groundwater.
- The 2D surface module (`solver.surface2d`), unless the module is configured with
  `-DOPENSWMM_WASM_2D=OFF`.
- GeoPackage models (SQLite compiled in) and HDF5: the 2D results file, `.h5` models and HDF5
  checkpoints.
- The 97 enumerations of the Python bindings, generated from the pinned engine, and the same
  error classes.

## What it does not do

- It is single threaded: one WebAssembly instance, no worker pool. `capabilities(mod)` reports one
  logical CPU.
- HydroCouple component libraries cannot be loaded, and the GPU plugin is not part of the build.
  The material split peer and the split packet codec raise `PluginError`.
- The package is not on the public npm registry yet. Releases are on
  [GitHub Releases](https://github.com/HydroCouple/openswmm.engine.wasm/releases); see
  {doc}`getting-started/installation`.
- The project's CI runs the module in Node.js only. Browser and web-worker use is not covered by
  its tests.

{doc}`guide/compatibility` lists the details.

## Versions

This manual describes version {sub-ref}`release` (`package.json`), an alpha release. The version
follows the Python package built from the same engine: `6.0.0-alpha.4.dev.2` here is
`openswmm 6.0.0a4.dev2` on PyPI.

```{toctree}
:hidden:
:maxdepth: 2

getting-started/index
guide/index
api/index
development/index
```
