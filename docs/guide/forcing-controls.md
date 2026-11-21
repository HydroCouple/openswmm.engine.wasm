# Forcing and controls

## Runtime forcing

`solver.forcing` overrides or adds to values the engine computes, while the model runs. Each call
names an element by **index** (`solver.nodes.getIndex("J1")`), a value, a mode and whether the
value persists:

- `ForcingMode.REPLACE` replaces the engine's value; `ForcingMode.ADD` adds to it.
- `persist = false` (the default) applies the value to the next step only; `persist = true` keeps
  it until it is replaced or cleared with `forcing.clear(target, index)` or `forcing.clearAll()`.

| Target | Calls |
| --- | --- |
| Nodes | `nodeLatInflow`, `nodeHeadBoundary`, `nodeQuality`, `nodeTemperature`, `nodeAge` |
| Links | `linkFlow`, `linkSetting`, `linkQuality`, `linkSeepage` |
| Subcatchments and gages | `subcatchRainfall`, `subcatchmentRainfall`, `subcatchmentEvap`, `subcatchmentSnowfall`, `gageRainfall` |
| Climate | `climateTemperature`, `climateWind`, `climateEvap`, `climateDryOnly` |

```{important}
Forced flows are in **ft³/s for every model**, the engine's internal unit, whatever its
`FLOW_UNITS` (`openswmm_forcing.h`: "internal ft3/s (CFS) for every project, including SI"). In an
SI model, multiply m³/s by 35.3146667 before forcing a flow; the {doc}`model-data` builder example
does this. The doc comments of the TypeScript methods say "flow units"; the engine's header is
the reference. Check the units of other forcing values in the C API reference of the
[engine manual](https://www.hydrocouple.org/openswmm.engine/).
```

The 2D surface has its own forcing calls, in SI units ({doc}`surface-2d`).

## Control rules

`solver.controls` holds the `[RULES]` of the model. `addRule(text)` takes a rule in the same
syntax as the `.inp` section and works after `open()` (or on a builder); `get(index)` returns
`{ id, text }`; `removeRule(index)` and `clearRules()` remove rules. While the model runs,
`setLinkSetting(index, fraction)` and `setLinkStatus(index, 0 | 1)` set a link directly.

## An example

The script runs the smoke model three times: as it is, with 2 cfs added at J1 for the first
hour, and with a rule that closes C1 once J1 is 0.3 ft deep.

```{literalinclude} ../examples/forcing_controls.mjs
:language: js
```

`node docs/examples/forcing_controls.mjs` prints the peak flow in C3 for each run:

```text
baseline          5.587
J1 +2 cfs, 1 hour 7.587
  added R1: 4 lines
rule closes C1    1.702
```
