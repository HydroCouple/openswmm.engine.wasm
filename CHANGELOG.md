# Changelog

All notable changes to `@hydrocouple/openswmm-engine-wasm` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The package version carries the qualifier of the `openswmm` Python package
built from the pinned engine (`tools/check_version.py`): Python
`6.0.0a4.dev2` is published here as `6.0.0-alpha.4.dev.2`. Entries can be drafted with
[git-cliff](https://git-cliff.org) (config: `cliff.toml`).

## [Unreleased]

### Changed

- **Engine pin advanced** from `ed32a16f` to `swmm6_rel` `85c47981`. The raw
  layer grows from 1,414 to 1,527 C functions (1,265 without the 2D headers):
  hot-start contents and legacy hot starts, recorded deletes and type
  conversion (`swmm_convert_types`), LID extras and storage LIDs, summary
  tables (`swmm_summary_*`), divider parameters, 2D initial HGL and results
  path, process-component arguments, and the new split, material-split, split
  packet and passive-exchange headers. Adds the `SWMM_PhaseCallback` typedef
  (`"viiddi"`) and the `SplitRole`, `SplitPhase`, `LidExtraField`,
  `SummaryTable` and `SummaryObject` enums; `GroundwaterVariable` gains `QX`
  and `QY`. No function was removed or changed signature.
- **Version qualifier follows the Python bindings**: `6.0.0-alpha.4.dev.2`
  for Python `6.0.0a4.dev2`; dev-qualified versions publish under the `dev`
  dist-tag.

### Added

- **Python API parity gate.** `tools/gen_python_surface.py` records the
  pinned engine's public Python surface (stubs and pure-Python modules) in
  `tests/fixtures/python_surface.json`; `tests/python_surface.test.ts` checks
  every member against the TypeScript classes, module by module, with aliases,
  reasoned exclusions and pending facade waves in `tools/python_surface_map.json`.
  Coverage per module is written to `tests/_work/python_parity_report.json`.
- **Real-module test tier** (`tests/wasm/`, vitest): runs the built
  `dist/` module; skipped with the reason in the title when `dist/` has no
  build. CI runs it after the Emscripten build. First test: the report summary
  tables after a full run.
- **`solver.fields`: engine fields by catalog path.** `fields.get("node.max_depth", "J1")`,
  `fields.set("link.roughness", "C1", 0.012)` and `fields.getAll("node.depth")`
  use the dotted paths of the engine catalog, the same names the Python
  bindings, the MCP server and the gymnasium use. The table is generated from
  the catalog (`tools/gen_fields.py`, run by `npm run gen` and checked in CI):
  181 of the catalog's 389 properties, every one that maps onto a single C
  getter and setter. `tests/fixtures/facade_coverage.json` records that
  coverage per target, and `tools/verify_fields_native.py` checks the table
  against the native engine and the Python bindings.
- **Trivial 2D example** (`examples/trivial_2d.inp`, `examples/trivial_2d.mjs`,
  shipped in the package): rain on a two-triangle sloped plane draining
  through one edge, with no 1D network. Featured in the README and run by
  `npm run smoke`.

### Fixed

- **The 1D-only build (`-DOPENSWMM_WASM_2D=OFF`) did not link**: its export
  list named the 17 `openswmm_coupling.h` and 3 `openswmm_surface_ownership.h`
  functions, which the engine implements in its 2D module. Both headers are now
  optional 2D headers, so the 1D-only export list has 1,265 functions.
- **Bit-flag enums were missing**: the enum generator skipped Python `IntFlag`
  classes, so `TraceFlags` and `TraceNodeFlags` were absent from the package.
  All 97 Python enum classes are now generated.
- **`Solver.currentDatetime`** returned 1900-era dates: `swmm_get_current_time`
  reports elapsed seconds, not an OADate. It is now start + elapsed, as in
  Python's `current_datetime`.

## [6.0.0-alpha.4.dev.2]

First release of the package.

### Added

- **Raw C API** generated from the engine headers (`tools/gen_bindings.py`):
  1,244 functions (1,048 without the 2D module), struct layouts and the
  callback typedefs with their `addFunction()` signatures, exported as
  `@hydrocouple/openswmm-engine-wasm/raw`.
- **TypeScript layer** mirroring the Python API for the solver lifecycle,
  nodes, links, subcatchments, gages, controls, runtime forcing, ARD transport,
  `ModelBuilder` and 2D surface routing (`Surface2D`, mesh infiltration);
  81 enum classes and the engine error hierarchy.
- **2D surface routing** built in, without the HDF5 results writer
  (`OUTPUT_FILE` is ignored with a warning; read results through `surface2d`).
- **GeoPackage** support, with SQLite compiled from the pinned amalgamation.
- **Smoke tests** for 1D and 2D runs that compare against native reference
  reports built with the WASM arithmetic (`tools/native_reference.sh`).

### Build

- Engine pinned to the published `swmm6_rel` branch.
- ESLint 9, Prettier and Ruff; CI workflows for build/test (Node 20, 22,
  24), lint, CLA and tag-driven releases to npm, GitHub Packages and GitHub
  Releases.

### Changed

- Licence changed from MIT to Apache-2.0.
