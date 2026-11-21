# Errors

Every nonzero return code of the C API becomes an exception. The classes check the code and throw
the subclass of `EngineError` that matches it; nothing fails silently.

```text
EngineError                code, codeEnum (ErrorCode), message
├── BadHandleError         BADHANDLE (7)
├── BadIndexError          BADINDEX (8)
│   └── ElementNotFoundError   an unknown id; elementId
├── BadParamError          BADPARAM (9)
├── LifecycleError         LIFECYCLE (6)
│   └── StaleObjectError       a view of a model that has since changed
├── HotStartError          HOTSTART (12)
├── PluginError            PLUGIN (10)
├── FileError              INPFILE (2), RPTFILE (3), OUTFILE (4), IO (11)
├── GeoPackageError        IO (11), from GeoPackage opens, queries and writes
├── ParseError             PARSE (5)
├── NumericalError         NUMERICAL (14)
├── CRSError               CRS (13)
└── DependencyError        DEPENDENCY (15)
```

`NOMEM` (1), `INTERNAL` (99) and codes without a subclass raise `EngineError` itself.
`raiseForCode(code, message?)` applies the same mapping to codes from raw calls. The classes
extend `Error` through `EngineError`; they are not also `RangeError` or `TypeError` instances.

```{literalinclude} ../examples/errors.mjs
:language: js
```

`node docs/examples/errors.mjs` prints:

```text
step() before open(): LifecycleError, code 6 (LIFECYCLE)
  state afterwards: NONE
nodes.get('J9'): ElementNotFoundError, code 8 (BADINDEX)
  ElementNotFoundError: true J9
callback error: RangeError: stop here
open(bad.inp): ParseError, code 5 (PARSE)
  ParseError: true
  ERROR 209: undefined object J1.
  ERROR 209: undefined object O1.
```

## What to know

- **A refused lifecycle call can end the engine.** In this build a `step()` refused with
  `LifecycleError` leaves the engine in state `NONE`, and a later `open()` is refused too. Create
  a new `Solver`.
- **Messages come from the engine.** For lifecycle and file calls `err.message` is the engine's
  last error message; other calls may give only `SWMM error <code>`. `solver.lastErrorCode`,
  `solver.lastErrorMessage` and `solver.errorMessage(code)` read the engine's values directly.
- **Parse errors are listed.** After a failed `open()`, `solver.openErrors` lists every error the
  parser recorded and `solver.openWarnings` its warnings. `setLenientOpen(true)` lets the parser
  continue past errors it can recover from.
- **Callback errors are rethrown.** An error thrown inside a callback is kept and rethrown, as
  is, when the engine call that ran the callback returns.
