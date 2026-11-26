# Model data

## Collections and element views

`solver.nodes`, `solver.links`, `solver.subcatchments` and `solver.gages` are collections of the
opened model. Each one has `length`, `ids` (in index order), `get(index | id)`, `getIndex(id)`
(`-1` when absent) and `getId(index)`, and is iterable with `for...of`. `get` returns an element
view (`Node`, `Link`, `Subcatchment`, `Gage`) whose properties read and write the engine directly.
Type-specific parts are sub-views: `node.storage`, `node.outfall`, `node.divider`, `link.xsect`,
`link.pump`, `link.weir`, `link.orifice`, `link.outlet`, `subcatchment.infiltration` and the
`stats` views of each element.

Bulk getters read one value per element in one call and return a copy: `nodes.depths`, `heads`,
`volumes`, `lateralInflows`, `overflows`; `links.flows`, `depths`, `velocities`, `capacities`;
`subcatchments.runoffs`, `rainfalls`; `gages.rainfalls`; and more in the {doc}`../api/index`.

```{literalinclude} ../examples/model_data.mjs
:language: js
```

`node docs/examples/model_data.mjs` prints:

```text
node 0 J1 JUNCTION invert 96
node 1 J2 JUNCTION invert 90
node 2 J3 JUNCTION invert 85
node 3 O1 OUTFALL invert 80
link C1 CONDUIT J1 -> J2, n = 0.01
subcatchments [ 'S1', 'S2' ] area of S1 10
C2 roughness by path: 0.013
describe link.flow: flow
ROUTING_STEP option: 30
ROUTING_STEP now: 15
routing step: 15 s
peak depths: 0.603 0.653 0.557 0.556
peak runoff from S1: 4.377
```

Values are in the model's units: feet, acres and CFS for this model.

```{note}
`Node.inflow` and `Nodes.inflows` return the node's **lateral** inflow only. The engine's
`swmm_node_get_inflow` reads the assembled lateral inflow and does not add the flow arriving
through links, so for J3 and the outfall O1 of this model they read 0 during the run. For flow
through the network read the links (`link.flow`), `node.outflow`, or the saved `total_inflow`
results ({doc}`results`).
```

## Editing

Edits go after `open()` and before `initialize()`: properties with a setter (`link.roughness`,
`node.invertElev`, `node.maxDepth`, `gage.scaleFactor`, ...), the `[OPTIONS]` block through
`solver.options`, time series and curves through `solver.tables`, patterns through
`solver.patterns`. Changes while the model runs go through runtime forcing and controls
({doc}`forcing-controls`).

`solver.editor` (`ModelEditor`) makes structural changes: deletes with impact reports and undo
records, type conversion, and splitting or joining conduits. After a structural edit, element
views taken before it raise `StaleObjectError`; take them again.

## Fields by catalog path

`solver.fields` reads and writes engine values by the dotted paths of the engine's API catalog,
the same addressing that the Python catalog (`openswmm.engine.catalog`), the MCP server and the
Gymnasium environments use. `fields.paths()` lists them, `fields.describe(path)` gives the C
functions, type and unit kind, `fields.get(path, element?)` and `fields.set(path, element,
value)` take an id or an index, and `fields.getAll(path)` reads every element.

This build reaches 182 catalog properties this way: those backed by exactly one simple C getter
(and setter). Properties that need unit conversion, tuples or records, and all methods, are only
available through the classes. Enumerations come back as numbers and Boolean fields as `true` or
`false`.

`catalog` (a namespace export) is the catalog itself: `catalog.lookup(path)`,
`catalog.members(target)`, `catalog.targets()`, `catalog.revision()`, and
`catalog.resolve(solver, target, key)`, which walks a catalog target to the live object on a
solver.

## Building a model in code

`ModelBuilder` creates a model through the API instead of a `.inp` file. The engine starts in
`BUILDING`; `finalize()` takes it to `INITIALIZED` and `toSolver()` hands the engine to a
`Solver`, after which the builder must not be used.

```{literalinclude} ../examples/builder.mjs
:language: js
```

`node docs/examples/builder.mjs` prints:

```text
state: INITIALIZED
C1 flow at the end: 0.0500 m³/s
[ '[JUNCTIONS]', '[OUTFALLS]', '[CONDUITS]' ]
```

```{note}
A new builder's options start at `START_DATE 01/01/2004` and `END_DATE 12/30/1899`, an end before
the start. Setting only `END_TIME` makes `finalize()` fail with a `ParseError`; set the dates as
the example does.
```

The builder has the same file helpers as the solver (`writeFile`, `readFile`), user flags,
`[FILES]` and `[PLUGINS]` rows, titles and the `nodes`, `links`, `subcatchments` and `gages`
collections of the model it builds.
