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

- **`Solver.startDatetime` / `endDatetime` are the configured `[OPTIONS]`
  dates**, as Python's `start_datetime` / `end_datetime`, and are now
  settable; `simStartTime` / `simEndTime` give the resolved times the engine
  runs (what `startDatetime` returned before; the two agree once a model is
  open). Dates are rounded to the millisecond.
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

- **HDF5 in the WASM build** (`-DOPENSWMM_WASM_HDF5=ON`, the default): HDF5
  2.1.1, the native engine's vcpkg release, is downloaded and built during
  configure. The 2D `[2D_OPTIONS] OUTPUT_FILE` results file is now written and
  readable through `swmm_output2d_*`, and `.h5` model output and HDF5
  checkpoints are available. Without zlib, like the native build, so the files
  open in native readers. About 3.3 MB more `.wasm`. Smoke test:
  `tests/smoke/hdf5.mjs`.
- **Tables, patterns, cross-sections and dates** mirroring Python's
  `_tables`, `_xsect`, `_geometry`, `_dates` and `_datetime`:
  `solver.tables` (`TimeSeries`, `Curve`, point editing, validated replacement,
  lookup), `solver.patterns`, `XSectionGeometry` (shapes, transects, shape
  curves, streets, a link's geometry; scalar or array queries), `CrossSection`,
  `oadateToDatetime`/`datetimeToOadate` and the engine's DateTime functions
  (`encodeDate(mod, ...)` ...). Also `GeoPackageError`. The parity gate maps
  Python's `ModelBuilder.add_subcatch`, `get_file_path`, `set_file_path` and
  `userflag_def_count` onto the existing `addSubcatchment`, `filePathGet`,
  `filePathSet` and `getUserflagDefCount`.
- **Gages, controls, forcing and snow** (wave B, part 1), mirroring Python:
  `Gages.add/rename/ids/has/reloadRainFiles`, `Gage.setFile/setTimeseries/
  setRainInterval/rainfallSeries/solver`; `Controls.append/insert/set/delete/
  clear/replaceProgram/findReferences/validateMessage`; forcing by id or index
  for subcatchment rainfall/evaporation/snowfall, node and link quality,
  climate temperature/wind/evaporation/dry-only and element climate;
  `solver.snow` (`Snow`: model, step, UEB options and monthly ranges, packs,
  `applyPacks`, snow state, UEB ledger, radiation, cloud, meteorology preview).
  As in Python, adding or renaming an element invalidates that collection's
  earlier views.
- **Saved results** (wave D, part 1), mirroring Python: `OutputReader` (binary
  `.out`: metadata, ids, period times, per-period results, series, attribute
  maps, node statistics; `live` reading with `refresh()`), `Output2DReader`
  (2D HDF5 results: datasets, attributes, shapes, numpy-style selections) and
  the `Results` facade (`ResultCollection`, `SeriesField`, `SurfaceResults`,
  `SurfaceField`, mesh, species, 2D mass balance), opened from a run by
  `solver.openResults()`. Reads return `NDArray` (`{ shape, data }`);
  `slice()` and `ELLIPSIS` build selections. Checked against native Python
  reading the same files.
- **Report snapshot** (wave C, part 5), mirroring Python `_report.py`:
  `getReportSnapshot(solver)` returns runoff, routing and quality continuity
  (errors in percent), routing diagnostics, flooded nodes, storage, link flow,
  pumping and subcatchment summaries. Its routing continuity error is the
  engine's exact ledger; the printed report uses legacy half-step totals, so
  the two can differ.
- **Hot starts and checkpoints** (wave C, part 4), mirroring Python:
  `HotStart` (save from a solver, open native or legacy files, metadata,
  node/link/subcatchment records with species, state edits, apply;
  `close()`/`using`), `solver.saveSchedule` (`[SAVE HOTSTART]` entries and
  formats) and `solver.checkpoints` (capabilities, session start/status,
  inspect, restore). Checkpoint saving and bundle export are refused in this
  build: the engine compiles its atomic no-replace publication only for
  Windows, macOS and Linux, so the capabilities omit SAVE_NEW/BUNDLE_EXPORT.
- **Inflows** (wave C, part 3), mirroring Python: `solver.inflows` for
  external inflows (time series, scale, baseline, pattern), dry-weather
  inflows (average and four patterns), RDII rows, unit-hydrograph groups
  (R/T/K, initial abstraction, gages, rename/remove) and RDII decay.
- **Climate and statistics** (wave C, part 2), mirroring Python:
  `solver.climate` (temperature source, evaporation, wind, humidity, snowmelt,
  areal depletion and monthly adjustments; `previewEvaporation` from the model
  or a draft configuration) and `solver.statistics` (node, link and
  subcatchment statistics as arrays or per element; report summary tables
  with titles, columns, rows and values).
- **Pollutants, quality, initial quality and mass balance** (wave C, part 1),
  mirroring Python: `solver.pollutants` (`Pollutant` concentrations, decay,
  units, snow-only, co-pollutant; add/rename, node and link quality),
  `solver.quality` (land uses with sweeping, buildup and washoff per land use
  and pollutant or reaction species, node treatment and its validator),
  `solver.initialQuality` (`[INITIAL_QUALITY]` rows incl. water age and
  temperature, file path) and `solver.massBalance` (continuity errors,
  runoff/routing totals, routing diagnostics, Courant, quality losses).
- **Subcatchments, aquifers and snowpacks** (wave B, part 3), mirroring
  Python: subcatchment roughness, depression storage, scale factors, tag,
  snowpack, gage, outlet (node or subcatchment), aquifer and groundwater node,
  groundwater parameters and state, snow state, rainfall/evaporation/
  infiltration/snow depth, quality and ponded quality, and the `infiltration`,
  `coverage`, `loadings` (pollutants or reaction species) and `stats`
  sub-views; collection `add`/`rename`/`ids`/`has`, bulk values and custom
  groundwater flow expressions; `solver.aquifers` and `solver.snowpacks`.
- **Nodes and links** (wave B, part 2), mirroring Python: node tag, virtual
  and inlet flags with their eligibility codes, rim/surcharge/ponded/initial
  depths, crown elevation, full volume, degree, quality and mass flux, and the
  `storage`, `outfall` (incl. `exportReceipt`) and `divider` sub-views; link
  geometry and hydraulics (length, roughness, offsets, losses, flap gate,
  seepage, culvert, barrels, ...), `fromNode`/`toNode`/`setNodes`, the `xsect`,
  `stats`, `pump`, `weir`, `orifice` and `outlet` sub-views; collection
  `add`/`popLast`/`rename`/`ids`/`has`, bulk inflows/outflows/losses,
  volumes, settings, hydraulic power, qualities and pump statistics. Sub-views
  of the wrong element type throw `TypeError`.
- **Structs by layout:** `readStruct`/`writeStruct`/`withStruct` read and write
  engine structs through the generated wasm32 layouts; the generator now
  handles nested structs and lays out the snow and radiation structs (all
  checked by `static_assert` under wasm32).
- **Solver members from Python's `_solver`** (wave A4): `options` (with
  `ext`), `userflags`, `events`; `openMetadata`, `openSimulationPeriod`,
  `advanceTo`, `until`, `steps()`, `elapsed`; `write`, `writeWithPlugin`,
  `writeCompat`, `writeStaged`; runoff interface files; diagnostics (`crs`,
  `openErrors`, `openWarnings`, `unitSystem`, `eventCount`, ...); and progress,
  warning, step-begin/end and phase callbacks through `addFunction`. A
  callback's error is kept and rethrown when the engine call returns, so it
  never unwinds through the engine. Module functions `run`, `runWithCallback`
  and `abiTag`. Accessors for later facade waves (climate, heat, coupling ...)
  are listed as pending in the parity gate.
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
