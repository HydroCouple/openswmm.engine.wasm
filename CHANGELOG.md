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

- **Version qualifier follows the Python bindings**: `6.0.0-alpha.4.dev.2`
  for Python `6.0.0a4.dev2`; dev-qualified versions publish under the `dev`
  dist-tag.

### Added

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
