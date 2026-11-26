# The raw layer

The raw layer is the generated table of every C function the module exports: 1,535 in this build
(`RAW_FUNCTION_COUNT`), from all headers in `include/openswmm/engine/` of the pinned engine. It is
the C API with JavaScript types, not the Python object API: use it for functions the classes do
not wrap, or to call the C API as documented in the
[engine manual](https://www.hydrocouple.org/openswmm.engine/).

`rawOf(mod)` returns the table for a module, built once per module instance; `bindRaw(mod)` builds
a new one. The package exports both; its `/raw` entry point exports the generated file alone:
`bindRaw`, `STRUCTS`, `CALLBACK_SIGNATURES` and `RAW_FUNCTION_COUNT`.

## Conventions

| C type | JavaScript |
| --- | --- |
| `int`, `double`, enums | `number` |
| Handles (`SWMM_Engine`, ...) and pointers | `number`: an address in the WebAssembly heap |
| `const char*` argument | `string` (or `null` for `NULL`); strings over 16,384 characters are copied to the heap instead of the 1 MB stack |
| `const char*` result | `string` |
| 64-bit integer passed by value | `bigint` (a `number` raises `TypeError`) |
| Callback | a function pointer from `mod.addFunction(fn, signature)` |

Most functions return a status code, `0` for success. Out-parameters are pointers into the heap
that the caller allocates (`mod._malloc`), reads (`mod.getValue`, `mod.HEAPF64`, ...) and frees
(`mod._free`). The helpers the classes use do those steps and raise the mapped error:
`withDouble`, `withInt`, `withCString`, `withDoubleArray` and `withDoubleInput`.
`raiseForCode(code)` throws the `EngineError` subclass for a status code.

```{literalinclude} ../examples/raw_layer.mjs
:language: js
```

`node docs/examples/raw_layer.mjs` prints:

```text
C functions: 1535 | ABI: openswmm-engine-abi/1
nodes: 4
invert of node 0: 96
invert of node 1: 90
features: { '2d': true, geopackage: true, hdf5_2d_output: true } | threads: 1
```

## Structs

`STRUCTS` holds the wasm32 layout of every C struct the API passes: its size and the byte offset,
C type and array length of each field, generated from the headers and checked against the
compiler under the wasm32 ABI in CI. `readStruct` turns a struct in the heap into a plain object
keyed by the C field names, `writeStruct` writes one back, and `withStruct` and `withStructs`
allocate structs around a call.

## What the raw layer does not do

- It does not track lifetimes: handles you create with `swmm_*_create` are yours to destroy, and
  raw calls on a solver's handle bypass the views' invalidation. Take element views again after
  structural changes made through raw calls.
- It does not check return codes: pass them to `raiseForCode`.
- In a module built with `-DOPENSWMM_WASM_2D=OFF`, the 2D functions are still in the table and
  throw "export ... is not available" when called.
