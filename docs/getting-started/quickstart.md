# Quick start

This page runs two models with Node.js: a small 1D network, stepped one routing step at a time,
and the trivial 2D example that ships with the package. Both scripts run from a clone of the
repository after the build described in {doc}`../development/building`; with the package
installed from a release, copy the script and its `.inp` file into your project and adjust the
path that reads the model.

## A 1D model, step by step

The model is the one the smoke tests run (`tests/fixtures/smoke.inp`): one rain gage, two
subcatchments, three junctions and three conduits in a line, and a free outfall, in US units (CFS)
over six hours of dynamic-wave routing.

```{literalinclude} ../examples/quickstart.mjs
:language: js
```

`node docs/examples/quickstart.mjs` prints:

```text
nodes 4, links 3
728 routing steps, ended at 2026-01-01T06:00:00.000Z
peak flow in C3 5.587 CFS
Continuity Error (%) .....        -0.174
Continuity Error (%) .....        -0.008
```

The two continuity lines are the runoff and flow routing balances of the report. The peak flow in
C3 is the outfall's maximum flow in the report's Outfall Loading Summary (5.59 CFS).

What the script shows:

- **One module, one engine per `Solver`.** `createOpenSwmmModule()` compiles the WebAssembly
  binary; `new Solver(mod)` creates an engine context in it. Several solvers can share a module.
- **Files live in the module.** `writeFile` puts the `.inp` text into the module's in-memory file
  system; the engine writes the `.rpt` and `.out` files there, and `readFile` reads them back.
  Nothing touches the disk unless your code copies it out.
- **The lifecycle is explicit.** `open`, `initialize`, `start`, `step` until it returns 0, then
  `end`, `report`, `close` and `destroy`. {doc}`../guide/running` covers the shortcuts (`run`,
  `steps()`, `advanceTo`, `until`).
- **Element views stay attached.** `solver.links.get("C3")` returns a view whose properties read
  the engine's current values on every access, until the model is closed.

## The trivial 2D example

Rain falls on a 100 m × 100 m plane, tilted 1 m toward its south edge and meshed as two triangles;
the water leaves through that edge. The deck has a rain gage, its time series and the `[2D_*]`
sections, and no 1D network.

```{literalinclude} ../../examples/trivial_2d.inp
:language: ini
```

The script, `examples/trivial_2d.mjs`, is part of the package and of `npm run smoke`, which fails
when the checks at its end stop holding:

```{literalinclude} ../../examples/trivial_2d.mjs
:language: js
```

`node examples/trivial_2d.mjs` prints:

```text
mesh: 4 vertices, 2 triangles
peak depth   0.0092 m
rainfall in  250.000 m³
edge outflow 248.331 m³
still stored 1.669 m³
continuity   8.98e-15 %
trivial_2d: OK
```

250 m³ is 25 mm of rain over 10,000 m²; the rest of the water is still on the plane when the run
ends. The engine also writes one line to standard error when the 2D solver starts, naming the
backend it chose (`[openswmm 2D] using CPU marcher ...`). The 2D surface works in SI units
whatever the model's flow units; {doc}`../guide/surface-2d` covers it.

```{note}
`getMassBalance().continuityError` is a fraction; the script prints it next to a `%` sign without
multiplying by 100.
```

## Next steps

- {doc}`browser` runs the 2D example in a web page.
- {doc}`../guide/concepts` explains how the package is put together.
- {doc}`../api/index` lists every class and function.
