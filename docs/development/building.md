# Building from source

## Prerequisites

- The [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html). The CI builds
  in the `emscripten/emsdk:6.0.9` container.
- CMake 3.21 or newer, Git, Python 3 (for the generators) and Node.js 20 or newer.

Clone with the engine submodule:

```bash
git clone --recurse-submodules https://github.com/HydroCouple/openswmm.engine.wasm.git
cd openswmm.engine.wasm
```

In an existing clone, `git submodule update --init --recursive` fetches it.

## Build

The npm scripts wrap the steps (`package.json`):

```bash
npm run configure:wasm   # emcmake cmake -B build -DCMAKE_BUILD_TYPE=Release
npm run build:wasm       # cmake --build build --parallel
npm ci
npm run build            # tsc: the TypeScript classes into dist/
```

The CMake build compiles the engine with the 2D module, GeoPackage (SQLite from the pinned
amalgamation) and HDF5, and writes `dist/openswmm_engine.js` and `dist/openswmm_engine.wasm`.
HDF5 2.1.1, the native engine's vcpkg release, is downloaded (SHA-512 checked) and built during
the first configure of a build directory. Options:

| CMake option | Default | Effect |
| --- | --- | --- |
| `OPENSWMM_WASM_2D` | `ON` | The 2D surface module; `OFF` saves about 0.6 MB |
| `OPENSWMM_WASM_GEOPACKAGE` | `ON` | GeoPackage models, with SQLite compiled in |
| `OPENSWMM_WASM_HDF5` | `ON` | The 2D results file, `.h5` models and HDF5 checkpoints (about 3.3 MB) |

The module is linked as an ES module factory (`-sMODULARIZE -sEXPORT_ES6`, named
`createOpenSwmmModule`) for the web, workers and Node.js, with WebAssembly exceptions, memory
growth from 64 MB to 4 GB, a 1 MB stack, table growth for callbacks, and the in-memory file
system.

## Checks

| Command | Checks | Needs the WebAssembly build |
| --- | --- | --- |
| `npm run typecheck` | TypeScript types | No |
| `npm test` | Unit tests against a mock module (`tests/*.test.ts`) and the real-module tests (`tests/wasm/`, skipped while `dist/` lacks a build) | For `tests/wasm/` |
| `npm run smoke` | The module in Node.js: exports, a 1D run against the native report, file I/O, junction storage, snow factors, 2D, HDF5, groundwater, and `examples/trivial_2d.mjs` | Yes |
| `npm run check:bindings` | The generated signatures, compiled natively against the engine headers | No (needs a host C++ compiler) |
| `npm run lint`, `npm run format:check`, `npm run lint:py` | ESLint, Prettier, Ruff | No |
| `npm run check` | typecheck, lint, format, Ruff and unit tests together | No |

The CI runs these in `.github/workflows/build.yml` (Node 20, 22 and 24, and the emsdk container)
and `lint.yml`.

## After advancing the engine submodule

The generated files must match the pinned engine. Regenerate them, then rebuild both the module
and the TypeScript:

```bash
npm run gen                                  # gen_bindings.py, gen_fields.py, gen_python_surface.py
python3 tools/gen_bindings.py --check
python3 tools/gen_fields.py --check
python3 tools/gen_python_surface.py --check
python3 tools/check_python_parity.py
npm run check:bindings
npm run typecheck && npm test && npm run build
npm run configure:wasm && npm run build:wasm
npm run smoke
```

| Generator | Reads | Writes |
| --- | --- | --- |
| `tools/gen_bindings.py` | The engine's C headers and Python enums | `src/js/raw.ts`, `src/js/raw.manifest.json`, `src/js/enums.ts`, `src/bindings/exported_functions*.json`, `tools/host_shim/raw_check.cpp` |
| `tools/gen_fields.py` | The engine's `catalog.json` and `raw.manifest.json` | `src/js/fields.generated.ts`, `src/js/catalog.generated.ts`, `tests/fixtures/facade_coverage.json` |
| `tools/gen_python_surface.py` | The engine's Python stubs and modules | `tests/fixtures/python_surface.json` |

Do not edit generated files by hand; change the generator or the engine. `--check` regenerates in
memory and fails when a committed file differs, which is the first step of the CI build.

## Releases

Pushing a tag `v<version>` runs `.github/workflows/release.yml`: it checks the tag against
`package.json` and the pinned engine's Python version, builds and tests the module in the emsdk
container, creates the GitHub Release (tarball, browser archive, `SHA256SUMS`) and publishes the
tarball to npm and GitHub Packages. The rules, the steps and the one-time registry setup are in
[RELEASING.md](https://github.com/HydroCouple/openswmm.engine.wasm/blob/dev/RELEASING.md).
