# WASM Bindings Finalization Plan — 2026-09-06

**Repo:** `openswmm.engine.wasm` (submodule `extern/openswmm.engine`, branch `swmm6_rel`)
**Goal:** Ship `@hydrocouple/openswmm-engine-wasm` 6.0.0 with full Python-binding parity (minus documented exclusions), GeoPackage support, real WASM tests, generated docs, and a tag-driven npm + GitHub Pages release.
**Status:** APPROVED 2026-09-06 (engine edits on `swmm6_rel`; generated cwrap raw layer; local emsdk available for builds; `./raw` export: yes).

---

## 0. Findings that shape the plan

| Finding | Consequence |
|---|---|
| Submodule pointer `1e531a8a` is 355 commits behind engine HEAD `d0a2155f` | Phase 0 bumps it; 6 `swmm_forcing_*` calls in `bindings.cpp` gained a `persist` arg and will break on bump |
| Python wraps **1,029** C functions / 30 modules; WASM exposes **153** (15 %) across 8 modules | Hand-writing ~900 more C++ shims is not viable → generate the raw layer |
| TS layer already passes raw `int` pointers + `_malloc`/`HEAPF64` | Embind adds nothing; switch raw layer to `EXPORTED_FUNCTIONS` + `cwrap` (no C++ shims except callbacks) |
| Engine CMake hard-codes `add_library(openswmm_engine SHARED …)`, links `dl`, `Threads`, OpenMP, uses `--whole-archive` for GeoPackage | Engine needs a small `EMSCRIPTEN` guard block (surgical, upstream to `openswmm.engine`) |
| Engine uses `std::thread` in `output/IOThread`, `core/ThreadInfo`, `hydraulics/DynamicWave` | WASM build is single-threaded (no `-pthread`); IOThread must have a synchronous path under `__EMSCRIPTEN__` |
| Plugins are `dlopen()`ed (`PluginFactory`) | No dynamic plugins in WASM; GeoPackage is already a builtin registered via `register_builtin_infos` — keep that path, stub `dlopen` |
| 2D module requires HDF5 | 2D excluded (user decision); `-DOPENSWMM_BUILD_2D=OFF` |
| No Emscripten toolchain obtainable in the Cowork sandbox (binary CDNs blocked, no clang) | Real WASM builds/tests run in GitHub Actions (`emscripten/emsdk` image). Sandbox verification = native `g++` "host-shim" compile of the generated raw layer against real engine headers + TS mock tests |
| Existing tests are mock-only | Add real-WASM test tier that runs only when `dist/openswmm_engine.wasm` exists (CI always; local when built) |

---

## 1. Scope

### In scope (Python parity)
`solver` (incl. callbacks, events, user flags, runoff interface, steady-state skip), `model`/`ModelBuilder`, `nodes` (+Storage/Outfall/Divider views), `links` (+XSection/Pump/Weir/Orifice/Outlet views, stats), `subcatchments` (+Aquifers, Snowpacks, Infiltration, Coverage, Loadings, groundwater, stats), `gages` (file-based gages included — files live in MEMFS), `controls`, `forcing` (climate + quality + persist), `hotstart` (+SaveSchedule), `climate`, `quality`/`landuse`, `pollutants`, `tables` (TimeSeries/Curve/Pattern), `xsect`, `inflows`, `infrastructure` (transects/streets/inlets/LIDs), `initial_quality`, `statistics`, `massbalance`, `output_reader` (`swmm_output_*`), `edit`/`ModelEditor`, `spatial`, `heat`, `reactions`, `water_age`, `process_components`, `geopackage`, `report` (ReportSnapshot, pure TS), `datetime`, all 58 enums, all 14 exceptions.

### Excluded (documented in README "Differences from Python")
- `_2d` / `infil2d` (HDF5) — revisit if HDF5 is made optional upstream.
- `output/_output` legacy `SMO_*` reader — separate library; `swmm_output_*` engine reader covers the use case.
- Dynamic plugin loading (`plugin_lib` arg, `swmm_plugin_set` with a path) — throws `PluginError` in WASM.
- `swmm_get_thread_info` / OpenMP thread control — returns 1 thread.
- Live output (`swmm_output_open_live`) — not Python-wrapped either.

---

## 2. Architecture decisions

1. **Raw layer is generated.** `tools/gen_bindings.py` parses `extern/openswmm.engine/include/openswmm/engine/*.h` (C prototypes marked `SWMM_ENGINE_API`) and emits:
   - `build/exported_functions.txt` → `-sEXPORTED_FUNCTIONS=@file` (plus `_malloc`, `_free`).
   - `src/js/raw.ts` — a typed `RawApi` interface + `bindRaw(mod)` that `cwrap`s every function (`number`/`string` arg kinds inferred from the C type; pointers are `number`).
   - `src/js/raw.manifest.json` — function name → signature, used by the parity test.
   - Type mapping: `SWMM_Engine`/`void*`/`T*` → `number`; `const char*` → `string`; `int`/`double`/enums → `number`; callbacks → excluded (manual, see 3).
2. **`bindings.cpp` shrinks** to: callback trampolines (`swmm_set_step_begin/end/warning/progress_callback`, `run_with_callback`) implemented with `emscripten::val` + `-sALLOW_TABLE_GROWTH` (`addFunction`), and `wasm_version()`. Embind is kept only for these.
3. **High-level TS layer mirrors Python 1:1** — same class names, same property/method names in camelCase, same sub-namespace accessors on `Solver` (`solver.hotstart`, `solver.climate`, …). One file per Python module under `src/js/`.
4. **Bulk data**: getters return `Float64Array`/`Int32Array` *copies* (heap may move on growth; no views handed out). Setters accept `ArrayLike<number>`.
5. **Files**: all paths are MEMFS paths. `Solver.writeFile/readFile/mountNodeFS(dir)` helpers; `-sFORCE_FILESYSTEM=1`. NODEFS enabled only for the `node` environment.
6. **GeoPackage**: engine built with `-DOPENSWMM_WITH_GEOPACKAGE=ON`; sqlite3 compiled from the pinned amalgamation (FetchContent, SHA3-verified) and exposed to the engine's `find_package(unofficial-sqlite3 CONFIG)` through a generated config package — no vcpkg bootstrap needed (decided in Phase 0: simpler than vcpkg's `wasm32-emscripten` triplet). `.gpkg` files are read/written in MEMFS.
7. **Engine changes stay minimal and upstreamed** to `openswmm.engine` (`swmm6_rel`), guarded by `if(EMSCRIPTEN)` / `#ifdef __EMSCRIPTEN__` only.
8. **Versioning**: package version tracks engine (`6.0.0-alpha.N` → `6.0.0`). npm dist-tag `next` for pre-releases, `latest` for finals. Tag `v6.0.0` on the wasm repo triggers release.

---

## 3. Phases

Each phase ends with a commit; verification criteria are the gate.

### Phase 0 — Green baseline build
1. Bump submodule to engine HEAD; add `ForcingPersist`, `ForcingType`, `RouteModel.FV`; fix 6 forcing arities.
2. Engine (`openswmm.engine`, surgical):
   - `src/engine/CMakeLists.txt`: `if(EMSCRIPTEN)` → `STATIC` library type + `OPENSWMM_ENGINE_STATIC`, skip `dl`, skip OpenMP/Threads link, skip `--whole-archive` (link options on a static lib are inert; the wasm consumer retains `swmm_gpkg_*` via `-sEXPORTED_FUNCTIONS`). SIMD flags already don't fire (`CMAKE_SYSTEM_PROCESSOR` is `x86` under emcc).
   - `output/IOThread`: synchronous execution under `__EMSCRIPTEN__` (no `std::thread`).
   - `plugins/PluginFactory`: `__EMSCRIPTEN__` branch stubbing `platform_load/unload/sym/error` and `get_library_directory` (the `<dlfcn.h>` include was gated on `__linux__ || __APPLE__` and hit `#error`). `core/ThreadInfo`: no change needed.
   - Done: engine commits `d204ea78`, `0e3155a` on `swmm6_rel`.
3. `openswmm.engine.wasm/CMakeLists.txt`: `-DOPENSWMM_BUILD_2D=OFF -DOPENSWMM_BUILD_GPU_PLUGIN=OFF -DOPENSWMM_WITH_GEOPACKAGE=ON`, sqlite amalgamation via FetchContent, `-fwasm-exceptions` (engine throws internally), `-sEXPORTED_FUNCTIONS`, `-sALLOW_TABLE_GROWTH`, `-sFORCE_FILESYSTEM`, `-sEXPORT_ES6=1`, `-sSTACK_SIZE=1MB`, `-sINITIAL_MEMORY=64MB`.
4. CI `build.yml`: emsdk container; wasm job must produce `dist/openswmm_engine.{js,wasm}` and run `npm run smoke` (`tests/fixtures/smoke.inp` → outfall peak within 2 % of the native reference `tests/fixtures/smoke.native.rpt`, routing continuity error < 1 %).
- **Verify:** CI wasm job green; smoke test passes; `.wasm` size reported in job summary.
- **Result (2026-09-06, local, Emscripten 6.0.9 via Homebrew, Node 24):** PASS — `openswmm_engine.wasm` 3.76 MB; smoke report identical to native (728 steps, O1 peak 5.59 cfs, routing CE −0.002 %). Fixes needed along the way: `PluginFactory` Emscripten stubs (engine `0e3155a`), Embind cannot bind `double*`/`int*` → out-params passed as heap offsets (wasm `7e9f697`). Smoke test needs Node ≥ 18 (wasm exceptions). CI pinned to `emscripten/emsdk:6.0.9`; CI itself not yet observed green (repos not pushed).
- **Engine issue found (not WASM-specific, not fixed here):** `swmm_node_get_inflow` returns `lat_flow` only (`src/engine/core/openswmm_nodes_impl.cpp:362`) while its header documents "lateral + upstream links"; Python bindings inherit the same behaviour.

### Phase 1 — Generated raw layer + host-shim check
1. `tools/gen_bindings.py` (+ `npm run gen`); commit generated `raw.ts`/manifest (reviewable diffs).
2. `tools/host_shim/` — native `g++` build that compiles a generated `raw_check.cpp` referencing every exported symbol against the real engine headers (`npm run check:bindings`). Runs in sandbox and CI. Fails on any signature drift.
3. Migrate existing TS classes from Embind names (`mod.swmm_x`) to `raw.swmm_x`.
4. Parity test: `tests/parity.test.ts` asserts every `swmm_*` in the Python `.pyx` files (scraped by `tools/python_surface.py`, minus the exclusion list) is present in `raw.manifest.json`.
- **Verify:** `npm run check:bindings`, `npm test` green; parity test reports 0 missing; CI wasm build still green.

### Phase 2 — High-level API, module by module
Order chosen by dependency and value; each step = TS module + mock tests + real-WASM tests + TypeDoc comments.
1. `solver` completion (callbacks, events, user flags, runoff interface, steady-state skip, sub-namespace accessors)
2. `datetime`, `tables`, `xsect`
3. `nodes` / `links` / `subcatchments` completion (views, stats, quality, tags, rename)
4. `gages` completion, `forcing` completion, `controls` (`findReferences`)
5. `statistics`, `massbalance`, `report` (ReportSnapshot)
6. `pollutants`, `quality`, `initial_quality`, `inflows`
7. `hotstart` (+SaveSchedule), `climate`
8. `output_reader`
9. `edit` (ModelEditor), `spatial`
10. `infrastructure`
11. `heat`, `reactions`, `water_age`, `process_components`
12. `geopackage`
- **Verify per module:** parity test for that module's Python class members (scraped `def`/`property` names → expected camelCase members exist on the TS class); real-WASM test exercises each method on `examples/` models.

### Phase 3 — Testing tiers
- `tests/unit/` — mock module (existing), fast.
- `tests/wasm/` — real module; skipped with a clear message if `dist/openswmm_engine.wasm` absent. Runs the engine regression models from `extern/openswmm.engine/tests/` where 1D-only, compares `.rpt` totals against the native engine's committed reference within tolerance.
- `tests/browser/` — one Playwright smoke (Chromium) loading the ES module in a page; runs in CI only.
- All test I/O written under `tests/_work/` (git-ignored, user-reviewable), never OS temp dirs.

### Phase 4 — Documentation
- `typedoc` → `docs/api/` (GitHub Pages); README rewritten: install, browser vs Node loading, MEMFS/NODEFS, Web Worker recipe, differences from Python, per-module examples.
- `docs/guide/` (markdown): quick start, runtime forcing/control loop, hotstart, water quality, GeoPackage in the browser, migration table Python ↔ TS.
- `CHANGELOG.md` (keep-a-changelog) started at 6.0.0.
- Engine `docs/` and `README.md` gain a "JavaScript / WebAssembly" section linking to the package (surgical).

### Phase 5 — Release & deployment
- `release.yml`: on tag `v*` → build WASM (Release, `-O3`, `--closure 0`), run all test tiers, `npm publish --provenance` (`NPM_TOKEN` secret; dist-tag from prerelease suffix), create GitHub Release with `dist/` tarball and size table, deploy TypeDoc to `gh-pages`.
- `npm pack` contents check (`dist/*.js`, `*.wasm`, `*.d.ts`, README, LICENSE, CHANGELOG); `package.json` `exports` map for `.`, `./wasm`, `./raw`; `sideEffects: false`.
- Release checklist in `RELEASING.md`.
- **Verify:** dry-run tag `v6.0.0-rc.1` publishes to `next`; `npm i @hydrocouple/openswmm-engine-wasm@next` in a scratch project runs the quick-start in Node and in a browser.

---

## 4. Risks

| Risk | Mitigation |
|---|---|
| Engine C++ has non-portable code beyond threads/dlopen (e.g. `std::filesystem`, `mmap`, SIMD intrinsics) | Surfaces in Phase 0 CI build; fix under `__EMSCRIPTEN__` guards; SIMD already has scalar fallback |
| sqlite.org download unavailable in CI | Mirror the pinned amalgamation zip into the repo's GitHub Release assets and point `FetchContent` at it |
| `.wasm` size > ~5 MB | `-Oz` variant, `-flto`, strip GeoPackage into optional second build if needed |
| Embind + `EXPORTED_FUNCTIONS` name clashes | Generator excludes callback functions; single source of truth for names |
| Generated `raw.ts` drifts from engine headers | `check:bindings` + parity test in CI on every push |
| Sandbox cannot run WASM | User pushes; I read CI results; user can run `npm run build:wasm` locally with emsdk |

---

## 5. Open questions for sign-off
1. OK to modify `openswmm.engine` (surgical `EMSCRIPTEN` guards) as part of this work, committed on `swmm6_rel`?
2. `nodeLatInflow(idx, value, mode, persist = ForcingPersist.STEP)` — default persist value: mirror Python's default?
3. Package `exports`: also publish a `./raw` entry exposing the generated `RawApi` for advanced users? (Recommended yes.)
4. npm org `@hydrocouple` — confirm you own it and can add `NPM_TOKEN` to repo secrets.
