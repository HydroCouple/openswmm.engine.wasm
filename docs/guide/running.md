# Running simulations

## The lifecycle calls

| Call | From state | Does |
| --- | --- | --- |
| `new Solver(mod)` | | Creates an engine context (`CREATED`) |
| `open(inp, rpt, out, pluginLib?)` | `CREATED`, `CLOSED` | Parses the model; element views become usable (`OPENED`) |
| `initialize()` | `OPENED` | Applies initial conditions and builds the solver state, including the 2D mesh (`INITIALIZED`) |
| `start(saveResults = true)` | `INITIALIZED` | Prepares stepping; `saveResults` writes the `.out` file (`RUNNING`) |
| `step()` | `RUNNING` | One routing step; returns the elapsed seconds, or 0 after the last step (`ENDED`) |
| `end()` | `RUNNING`, `ENDED` | Finishes the run and the mass balances; can stop a run early |
| `report()` | `ENDED` | Writes the `.rpt` file |
| `close()` | `ENDED` | Releases the model; the engine can open another (`CLOSED`) |
| `destroy()` | any | Frees the engine context; repeated calls do nothing |

`open` takes a fourth argument, the input plugin: an `.h5` model opens only when its plugin is
named (`"org.hydrocouple.openswmm.plugins.hdf5"`); without one the built-in `.inp` reader is used.
`setLenientOpen(true)` before `open` lets the parser continue past errors it can recover from.

## Shortcuts

```{literalinclude} ../examples/running.mjs
:language: js
```

`node docs/examples/running.mjs` prints:

```text
run(): report has 8899 chars
after solver.run(): CLOSED
advanceTo(3600) reached 3600 s
until(02:00 UTC) reached 7224.917999999997 s
480 more steps; 727 step-end callbacks in all
state: ENDED elapsed: 21600 s
```

- `run(mod, inp, rpt?, out?)` is the module-level one-shot run (Python `openswmm.engine.run`);
  `runWithCallback` adds a progress callback.
- `solver.run(inp, rpt, out)` opens, initializes, starts, steps to the end, ends, reports and
  closes. If any of those calls fails it closes and **destroys** the solver before rethrowing.
- `advanceTo(seconds)` steps until the elapsed time reaches `seconds`; `until(target)` takes a
  `Date` or elapsed seconds and stops at the first step at or past it, so the time it returns can
  overshoot the target by part of a step; `stride(n)` takes `n` routing steps.
- `steps()` is a generator over the remaining steps that yields the elapsed seconds after each
  one.
- `solver.elapsed` and `solver.currentDatetime` give the current simulation time;
  `startDatetime`, `endDatetime` and `reportStartDatetime` read and write the `[OPTIONS]` dates.

## Callbacks

`setProgressCallback`, `setWarningCallback`, `setStepBeginCallback`, `setStepEndCallback` and
`setPhaseCallback` register a JavaScript function that the engine calls during its own calls;
`null` removes it. Each callback is turned into a WebAssembly function pointer with
`addFunction`, and `destroy()` releases it.

A callback may read the model. It must not change the lifecycle or step the engine: such calls
raise `LifecycleError`. An error a callback throws cannot cross the engine's C++ frames, so the
class keeps the first one, skips the later callbacks of the same engine call, and rethrows the
error when that call returns ({doc}`errors` has an example).

## Partial opens

`openMetadata(inp)` reads a model without its simulation state, to inspect or edit it.
`openSimulationPeriod(inp)` skips the 2D mesh and the rows that address its cells, so a large 2D
model opens quickly when only its dates and options are needed.

## Saving models

| Call | Writes |
| --- | --- |
| `write(path)` | The model as OpenSWMM Engine `.inp` input |
| `writeCompat(path, profile)` | Full, OpenSWMM-legacy or stock EPA SWMM 5 input (`InpProfile`); conversion warnings go to `openWarnings` |
| `writeWithPlugin(path, pluginId)` | Through an output plugin (`""` is the built-in `.inp` writer) |
| `writeGeopackage(path, crs?)` | A GeoPackage model, through the built-in GeoPackage plugin |
| `writeStaged(finalPath, mapper)` | The model and its side files to staging paths your code chooses |

Hot start files, the save schedule and checkpoint
sessions are under `solver.saveSchedule` and `solver.checkpoints`; checkpoints are only written to
new destinations, never over an existing file or folder.
