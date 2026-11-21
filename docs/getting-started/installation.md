# Installation

## Requirements

- **Node.js 20 or newer** (`engines` in `package.json`). The CI tests Node 20, 22 and 24. The
  module is compiled with WebAssembly exception handling (`-fwasm-exceptions`), which older
  runtimes do not support.
- **A browser** that runs ES modules and WebAssembly exception handling, for browser use. The
  project's CI does not run the module in a browser; see {doc}`browser`.

## Install a release

Each [GitHub Release](https://github.com/HydroCouple/openswmm.engine.wasm/releases) carries the npm
tarball, a browser archive and their checksums:

| Asset | Contents |
| --- | --- |
| `hydrocouple-openswmm-engine-wasm-<version>.tgz` | The npm package |
| `openswmm-engine-wasm-<version>-browser.zip` | The ES module glue, the `.wasm` and the compiled wrappers, for use without a bundler |
| `SHA256SUMS` | SHA-256 checksums of both |

npm installs the tarball from its URL:

```bash
npm install https://github.com/HydroCouple/openswmm.engine.wasm/releases/download/v6.0.0-alpha.4.dev.2/hydrocouple-openswmm-engine-wasm-6.0.0-alpha.4.dev.2.tgz
```

To check a download against the published checksums (here with the
[GitHub CLI](https://cli.github.com/)):

```bash
gh release download v6.0.0-alpha.4.dev.2 -R HydroCouple/openswmm.engine.wasm
shasum -a 256 -c SHA256SUMS
```

The release workflow also publishes the package to GitHub Packages, whose npm registry requires an
authenticated client (a token with `read:packages`) even for public packages.

```{note}
The package is not on the public npm registry yet: `npm install @hydrocouple/openswmm-engine-wasm`
answers 404. When it is, the release workflow publishes development versions under the `dev`
dist-tag, other pre-releases under `next` and releases under `latest`.
```

## Check the installation

The `/wasm` entry point is an Emscripten factory. Importing it loads the JavaScript glue only; the
WebAssembly binary is fetched and compiled when `createOpenSwmmModule()` runs, which returns a
promise.

```{literalinclude} ../examples/check_install.mjs
:language: js
```

In a project with `"type": "module"` in its `package.json`, `node check_install.mjs` prints:

```text
openswmm-engine-wasm 6.0.0-alpha.4.dev.2, catalog revision 2
features: { '2d': true, geopackage: true, hdf5_2d_output: true }
```

## What the package contains

It is an ES module package: its `exports` define `import` conditions only, so `require()` cannot
load it. It has four entry points:

| Import specifier | File | Contents |
| --- | --- | --- |
| `@hydrocouple/openswmm-engine-wasm` | `dist/index.js` | The TypeScript classes, enumerations, errors and helpers, with type declarations |
| `@hydrocouple/openswmm-engine-wasm/raw` | `dist/raw.js` | The generated raw layer: `bindRaw`, `STRUCTS`, `RAW_FUNCTION_COUNT` |
| `@hydrocouple/openswmm-engine-wasm/wasm` | `dist/openswmm_engine.js` | The Emscripten module factory, `createOpenSwmmModule` |
| `@hydrocouple/openswmm-engine-wasm/openswmm_engine.wasm` | `dist/openswmm_engine.wasm` | The compiled engine (about 12 MB) |

It also ships the TypeScript sources (`src/`) and the trivial 2D example (`examples/`).

## Versions

The version follows the Python package built from the same engine, in SemVer spelling:
`6.0.0-alpha.4.dev.2` is `openswmm 6.0.0a4.dev2` on PyPI. The release workflow refuses a tag that
does not match `package.json` or the pinned engine's Python version (`tools/check_version.py`).
Changes are listed in
[CHANGELOG.md](https://github.com/HydroCouple/openswmm.engine.wasm/blob/dev/CHANGELOG.md).
