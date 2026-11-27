# Compatibility with the native engine

## The Python API, member for member

The TypeScript classes are tracked against the engine's Python bindings. The generator
`tools/gen_python_surface.py` writes the pinned engine's public Python surface to
`tests/fixtures/python_surface.json`, and `tests/python_surface.test.ts` requires a camelCase
counterpart for every member that `tools/python_surface_map.json` does not exclude, with a reason.
For the pinned engine, all 2,489 members have a counterpart or a recorded exclusion, and no module
is pending.

Names change case and some Python idioms change form:

| Python | TypeScript |
| --- | --- |
| `solver.surface2d.get_depths()` | `solver.surface2d.getDepths()` |
| `n_triangles` | `nTriangles` |
| `with Solver(...) as s:` | `using s = new Solver(mod)` where supported, or `destroy()` |
| `datetime` | `Date` (UTC wall clock) |
| NumPy arrays | typed arrays (`Float64Array`, ...) and `NDArray` (`{ shape, data }`) |
| Exceptions (`EngineError` and subclasses) | The same class names |
| Records with snake_case keys | Plain objects with camelCase keys (`appliedM3`, `flowM3S`) |

The raw layer covers every C function, and `capabilities(mod)` returns the same JSON document as
Python's `openswmm.engine.capabilities()`, so a service can publish either unchanged.

## What WebAssembly leaves out

| Feature | In this package |
| --- | --- |
| Threads | One thread in the published build; a threads build runs the engine's OpenMP loops on WebAssembly threads ([threads](concepts.md#threads)) |
| GPU | The native GPU plugin is not part of the build; a WebGPU build carries the WebGPU 2D marcher, opt-in per model ([the WebGPU marcher](surface-2d.md#the-webgpu-marcher)) |
| HydroCouple component libraries | Not loadable: `solver.processComponents.libraries` is empty and `addSearchPath` throws |
| Material split peer, split packet codec | Raise `PluginError`; they need an engine built with HydroCouple |
| HDF5 compression | None (like the native vcpkg build): files are written uncompressed and native builds read them |
| Catalog fields | 182 catalog properties by path; the rest through the classes ({doc}`model-data`) |

## Other boundaries

- **Raw calls bypass the views.** Mutations made through raw calls do not invalidate element
  views; take them again.
- **Runtime sources on the 2D surface** are total SI m³/s per cell, and the FULL_SWE momentum
  equation refuses them.
- **Forcing units** follow the engine: flows in ft³/s ({doc}`forcing-controls`).
- **Checkpoints** are saved only to new destinations, and exporting a bundle needs a file-backed
  checkpoint session.
- **The browser is not tested by CI.** The smoke tests and the real-module tests run in Node.js;
  browsers, workers and heap exhaustion are not covered.

## Newer engine APIs

The submodule pin is the source of truth. A sibling checkout of the engine can have newer APIs;
they reach this package only when the submodule is advanced and the bindings regenerated and
rebuilt ({doc}`../development/building`).
