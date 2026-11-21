# Results

A run leaves its results in three places in the module's file system: the text report (`.rpt`,
after `report()`), the binary output (`.out`, when `start(true)` saved results) and, for a 2D
model with `[2D_OPTIONS] OUTPUT_FILE`, the HDF5 surface results.

## Results and fields

`solver.openResults()` opens the run's files after `end()`: the `.out`, and the 2D file when the
model sets one (found while the engine is alive; after `destroy()` pass it as
`openResults({ surface: path })`). With `{ live: true }` it opens only the `.out`, during a run;
`results.refresh()` picks up the periods written since.

The returned `Results` has the collections `nodes`, `links`, `subcatchments` and `system` (1D) and
`surface` (2D). Their variables are lazy fields: a field describes itself (`units`, `dimensions`,
`shape`, `times`) and loads values only on `read()`. `read` takes named selectors, as in Python:

- `objects`: ids, indices, a list, or `slice(start, stop, step)`;
- `periods`: an index (negative counts from the end), a list or a slice;
- `species`: a pollutant name or index, for quality variables.

It returns an `NDArray` (`{ shape, data }`) in row-major order. The data is a copy and stays
valid after the readers close. `results.close()` closes them; `Results` also implements
`Symbol.dispose`.

```{literalinclude} ../examples/results.mjs
:language: js
```

`node docs/examples/results.mjs` prints:

```text
report periods: 72 first 2026-01-01T00:05:00.000Z
node variables: depth, head, volume, lateral_inflow, total_inflow, overflow
depth: ft [ 'time', 'object' ] [ 72, 4 ]
shape [ 12, 2 ] at 01:00 J1 0.490 J2 0.518
J1 peak depth: 0.520 ft
reader: 4 nodes, 72 periods
J1 depth series: 72 values, max 0.520
```

The file holds one value per report step (5 minutes in this model), so a peak between two report
times is not in it.

## Readers

`OutputReader(mod, path)` reads a `.out` file directly, also one copied into the module from
elsewhere: counts, ids, report times, per-period values (`nodeResult`, `linkResult`, ...), series
(`nodeSeries`, ...) and node statistics. `Output2DReader(mod, path)` reads the 2D HDF5 file by
dataset path (`datasets`, `attributes`, `shape`, `read`); `results.surface` arranges the same file
as a mesh (`surface.mesh`: vertices, cells) and per-cell variables. Both readers own native
memory: `close()` them, or use them with `using`.

## The report

`solver.report()` writes the `.rpt` text. The same numbers are available as data:
`solver.massBalance` has the continuity errors, totals and routing diagnostics;
`solver.statistics` has per-element run statistics and, from the end of the run until `close()`,
the report's summary tables; `getReportSnapshot(solver)` collects the continuity and the node,
link, pump and subcatchment summaries of an ended run into plain objects.
