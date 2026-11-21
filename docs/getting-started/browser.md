# In a browser

The module is built for the web, web workers and Node.js (`-sENVIRONMENT=web,worker,node`) as an
ES module. In a page it fetches `openswmm_engine.wasm` from the folder of `openswmm_engine.js`
(Emscripten's `new URL("openswmm_engine.wasm", import.meta.url)`), so the two files stay together.

```{important}
The project's CI runs the module in Node.js only. The page below was run by hand in headless
Chrome 157 for this manual; other browsers, bundlers and web workers are not tested.
```

## Without a bundler

Each GitHub Release has a browser archive, `openswmm-engine-wasm-<version>-browser.zip`: one
folder with the Emscripten glue, the `.wasm` and the compiled TypeScript classes. The page below
sits next to the unzipped folder and a copy of `examples/trivial_2d.inp`:

```text
site/
├── browser.html
├── trivial_2d.inp
└── openswmm-engine-wasm-6.0.0-alpha.4.dev.2/
    ├── index.js
    ├── openswmm_engine.js
    ├── openswmm_engine.wasm
    └── ...
```

```{literalinclude} ../examples/browser.html
:language: html
```

Serve `site/` over HTTP and open `browser.html`. The page imports some 60 module files at once:
Python's `python3 -m http.server`, which keeps only 5 pending connections, stalled the page in 2
of 6 runs here; a static server with a larger connection backlog loaded it every time (4 of 4).
The page shows:

```text
peak depth 0.0092 m
rainfall in 250.000 m³
edge outflow 248.331 m³
```

These are the values `node examples/trivial_2d.mjs` prints. The engine's 2D backend notice appears
in the browser console as an error-level message (`[openswmm 2D] using CPU marcher ...`); it is
information, not a failure.

## With a bundler

The npm package's `/wasm` entry point is the same Emscripten factory. A bundler has to copy
`dist/openswmm_engine.wasm` next to the bundled glue, or the factory has to be told where the file
is: it accepts Emscripten's usual module options, including `locateFile`. No bundler
configuration is tested by the project.

## Things to know

- **Calls are synchronous.** `step()`, `run()` and the other engine calls run to completion on the
  thread that makes them; a long run on the main thread blocks the page until it returns.
- **Memory.** The module starts with 64 MB and grows up to 4 GB (`ALLOW_MEMORY_GROWTH`).
- **Files.** Inputs come from `fetch`, file pickers or strings: write them with
  `solver.writeFile`. Results stay in the module's memory until you read them with
  `solver.readFile` or the result readers ({doc}`../guide/results`).
