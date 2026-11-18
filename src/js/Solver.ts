/**
 * @file Solver.ts
 * @brief Main engine lifecycle controller for the OpenSWMM WASM bindings.
 *
 * @details Mirrors the Python `_solver.pyi` specification. `Solver` wraps the
 * full lifecycle of a SWMM engine context:
 *
 * ```
 * create → open → initialize → start → [step/stride …] → end → report → close → destroy
 * ```
 *
 * The class also exposes typed accessors for nodes, links, subcatchments,
 * gages, controls, forcing, transport and the 2D surface ({@link Solver.surface2d}).
 *
 * ### Virtual filesystem
 * The WASM engine uses the Emscripten MEMFS virtual filesystem. Call
 * {@link Solver.writeFile} to upload .inp, hot-start, and other files before
 * opening the engine. After the simulation you can read the .rpt/.out files
 * back with {@link Solver.readFile}.
 *
 * ### Example
 * ```ts
 * import createOpenSwmmModule from "./dist/openswmm_engine.js";
 * import { Solver } from "@hydrocouple/openswmm-engine-wasm";
 *
 * const mod = await createOpenSwmmModule();
 * const solver = new Solver(mod);
 *
 * solver.writeFile("/model.inp", inpBytes);
 * solver.open("/model.inp", "/model.rpt", "/model.out");
 * solver.initialize();
 * solver.start(true);
 *
 * while (solver.step() > 0) {
 *   const depths = solver.nodes.depths;
 *   // … react to state …
 * }
 *
 * solver.end();
 * solver.report();
 * solver.close();
 * solver.destroy();
 *
 * const rpt = solver.readFile("/model.rpt", "utf8");
 * console.log(rpt);
 * ```
 *
 * @author   Caleb Buahin <caleb.buahin@gmail.com>
 * @copyright Copyright (c) 2026 Caleb Buahin. All rights reserved.
 * @license  Apache-2.0
 */

import { EngineState, FlowUnits, InpProfile } from "./enums.js";
import { BadHandleError, EngineError, raiseForCode } from "./errors.js";
import { Nodes } from "./Nodes.js";
import { Links } from "./Links.js";
import { Subcatchments } from "./Subcatchments.js";
import { Gages } from "./Gages.js";
import { Controls } from "./Controls.js";
import { Transport } from "./Transport.js";
import { Forcing } from "./Forcing.js";
import { Fields } from "./Fields.js";
import { Surface2D } from "./Surface2D.js";
import { Patterns, Tables } from "./Tables.js";
import type { OpenSwmmWasmModule } from "./types.js";
import { CALLBACK_SIGNATURES, type RawApi } from "./raw.js";
import { checkedAlloc, rawOf, withCString, withDouble, withInt } from "./mem.js";
import { datetimeToOadate, oadateToDatetime } from "./dates.js";
import { EventsView, SimulationOptions, UserFlags } from "./SolverViews.js";
import { Snow } from "./Snow.js";
import { Aquifers, Snowpacks } from "./NamedObjects.js";
import { InitialQuality } from "./InitialQuality.js";
import { MassBalance } from "./MassBalance.js";
import { Pollutants } from "./Pollutants.js";
import { Quality } from "./Quality.js";

// =============================================================================
// Solver
// =============================================================================

/**
 * Lifecycle controller for a SWMM engine instance.
 *
 * Each `Solver` manages exactly one `SWMM_Engine` handle. The handle is
 * created in the constructor and destroyed in {@link Solver.destroy} (or when
 * used as a `using` resource in environments that support the TC39
 * Explicit Resource Management proposal).
 */
export class Solver {
  /** @internal */
  private readonly _mod: OpenSwmmWasmModule;
  private readonly _raw: RawApi;

  /**
   * Opaque engine handle (integer pointer into WASM heap).
   *
   * This is the value passed as the first argument to every C API call.
   * Reading `handle` from JavaScript is possible but manipulating it
   * directly is unsupported.
   */
  private _handle: number;

  get handle(): number {
    this._assertAlive();
    return this._handle;
  }

  private _assertAlive(): void {
    if (!this._handle) throw new BadHandleError("Solver has been destroyed");
  }

  private _invalidateViews(): void {
    this._generation++;
    this.nodes.generation++;
    this.links.generation++;
    this.subcatchments.generation++;
    this.gages.generation++;
    this.tables.generation++;
    this.patterns.generation++;
  }

  // -------------------------------------------------------------------------
  // Domain collection lazily-created views
  // -------------------------------------------------------------------------

  /**
   * Node collection.
   *
   * Populated after {@link Solver.open} succeeds.
   */
  readonly nodes: Nodes;

  /**
   * Link collection.
   *
   * Populated after {@link Solver.open} succeeds.
   */
  readonly links: Links;

  /**
   * Subcatchment collection.
   *
   * Populated after {@link Solver.open} succeeds.
   */
  readonly subcatchments: Subcatchments;

  /**
   * Rain gage collection.
   *
   * Populated after {@link Solver.open} succeeds.
   */
  readonly gages: Gages;

  /**
   * Control rules collection.
   *
   * Populated after {@link Solver.open} succeeds.
   */
  readonly controls: Controls;

  /**
   * Runtime forcing interface.
   *
   * Available from {@link Solver.start} onward.
   */
  readonly forcing: Forcing;

  readonly transport: Transport;

  /**
   * 2D surface routing (Python `solver.surface2d`).
   *
   * Active once the model has a 2D mesh and {@link Solver.initialize} has
   * run; check {@link Surface2D.isActive}. Live results are read here; a
   * `[2D_OPTIONS] OUTPUT_FILE` is written to the virtual filesystem.
   */
  readonly surface2d: Surface2D;

  /**
   * Engine fields by catalog path (`"node.max_depth"`, `"link.stats.max_flow"`, ...),
   * the addressing the Python catalog, MCP server and gymnasium share.
   */
  readonly fields: Fields;

  /** Time series and curves (Python `solver.tables`). */
  readonly tables: Tables;

  /** Time patterns (Python `solver.patterns`). */
  readonly patterns: Patterns;

  /** The `[OPTIONS]` block and its typed shortcuts (Python `solver.options`). */
  readonly options: SimulationOptions;

  /** User flags (Python `solver.userflags`). */
  readonly userflags: UserFlags;

  /** The `[EVENTS]` periods (Python `solver.events`). */
  readonly events: EventsView;

  /** @internal */
  private _generation = 0;
  /** @internal First error a JavaScript callback raised during the current native call. */
  private _callbackError: unknown = undefined;
  /** @internal Function-table slots of the registered callbacks, by kind. */
  private readonly _callbackSlots = new Map<string, number>();

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  /**
   * Create a new engine context and domain collection wrappers.
   *
   * @param mod             The Emscripten module returned by `createOpenSwmmModule()`.
   * @param existingHandle  Optional existing engine handle (e.g. from {@link ModelBuilder.toSolver}).
   *                        When provided, the solver takes ownership of this handle without
   *                        calling `swmm_engine_create`.
   * @throws {@link EngineError} if a new engine context cannot be allocated.
   */
  constructor(mod: OpenSwmmWasmModule, existingHandle?: number) {
    this._mod = mod;
    this._raw = rawOf(mod);
    let h: number;
    if (existingHandle !== undefined && existingHandle !== 0) {
      h = existingHandle;
    } else {
      h = rawOf(mod).swmm_engine_create();
      if (!h) throw new EngineError(7, "swmm_engine_create() returned NULL");
    }
    this._handle = h;
    this.nodes = new Nodes(mod, h, () => this._assertAlive(), this);
    this.links = new Links(mod, h, () => this._assertAlive(), this);
    this.subcatchments = new Subcatchments(mod, h, () => this._assertAlive(), this);
    this.gages = new Gages(mod, h, () => this._assertAlive(), this);
    this.controls = new Controls(mod, h, () => this._assertAlive());
    this.transport = new Transport(mod, h, () => this._assertAlive());
    this.forcing = new Forcing(mod, h, () => this._assertAlive());
    this.surface2d = new Surface2D(mod, h, () => this._assertAlive());
    this.fields = new Fields(mod, () => this.handle);
    this.tables = new Tables(mod, h, this, () => this._assertAlive());
    this.patterns = new Patterns(mod, h, this, () => this._assertAlive());
    const host = {
      mod,
      raw: this._raw,
      solver: this as Solver,
      get handle(): number {
        return this.solver.handle;
      },
    };
    this.options = new SimulationOptions(host);
    this.userflags = new UserFlags(host);
    this.events = new EventsView(host);
  }

  // -------------------------------------------------------------------------
  // Virtual filesystem helpers
  // -------------------------------------------------------------------------

  /**
   * Write bytes or a string to the Emscripten virtual filesystem.
   *
   * @param path  Absolute path inside the WASM virtual filesystem.
   * @param data  File contents.
   */
  writeFile(path: string, data: Uint8Array | string): void {
    this._mod.FS.writeFile(path, data);
  }

  /**
   * Read a file from the virtual filesystem as a byte array.
   */
  readFile(path: string): Uint8Array;

  /**
   * Read a file from the virtual filesystem as a UTF-8 string.
   */
  readFile(path: string, encoding: "utf8"): string;

  /**
   * Read a file from the virtual filesystem.
   */
  readFile(path: string, encoding?: "utf8"): Uint8Array | string {
    if (encoding === "utf8") {
      return this._mod.FS.readFile(path, { encoding: "utf8" });
    }
    return this._mod.FS.readFile(path, { encoding: "binary" });
  }

  /** Save the currently opened model to a file in the virtual filesystem. */
  writeModel(path: string, outputPluginId = ""): void {
    const h = this.handle;
    const rc = outputPluginId
      ? this._raw.swmm_model_write_with_plugin(h, path, outputPluginId)
      : this._raw.swmm_model_write(h, path);
    this._rethrowCallbackError();
    raiseForCode(rc, rc ? this._raw.swmm_get_last_error_msg(h) : undefined);
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /**
   * Allow the engine to continue past non-fatal parse errors.
   *
   * Must be called before {@link Solver.open}.
   *
   * @param on  `true` to enable lenient mode.
   */
  setLenientOpen(on: boolean): void {
    this._raw.swmm_engine_set_lenient_open(this.handle, on ? 1 : 0);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Open a SWMM model from .inp/.rpt/.out paths on the virtual filesystem.
   *
   * @param inp        Path to the SWMM input (.inp) file.
   * @param rpt        Path where the report (.rpt) file will be written.
   * @param out        Path where the binary output (.out) file will be written.
   * @param pluginLib  Optional path to a SWMM plugin library (pass `""` if none).
   *
   * @throws {@link FileError}   if any file path is inaccessible.
   * @throws {@link ParseError}  if the input file contains errors (unless
   *                              lenient mode is enabled).
   * @throws {@link LifecycleError} if the engine is not in `CREATED` state.
   */
  open(inp: string, rpt: string, out: string, pluginLib = ""): void {
    this._invalidateViews();
    const rc = this._raw.swmm_engine_open(this.handle, inp, rpt, out, pluginLib || null);
    this._rethrowCallbackError();
    if (rc !== 0) {
      const msg = this._raw.swmm_get_last_error_msg(this.handle);
      raiseForCode(rc, msg);
    }
  }

  /**
   * Apply initial conditions to the opened model.
   *
   * @throws {@link LifecycleError} if not in `OPENED` state.
   */
  initialize(): void {
    const rc = this._raw.swmm_engine_initialize(this.handle);
    this._rethrowCallbackError();
    if (rc !== 0) {
      raiseForCode(rc, this._raw.swmm_get_last_error_msg(this.handle));
    }
  }

  /**
   * Prepare the solver for time-stepping.
   *
   * @param saveResults  Write results to the binary output file (default: `true`).
   * @throws {@link LifecycleError} if not in `INITIALIZED` state.
   */
  start(saveResults = true): void {
    const rc = this._raw.swmm_engine_start(this.handle, saveResults ? 1 : 0);
    this._rethrowCallbackError();
    if (rc !== 0) {
      raiseForCode(rc, this._raw.swmm_get_last_error_msg(this.handle));
    }
  }

  /**
   * Advance the simulation by one routing step.
   *
   * @returns Elapsed simulation time in seconds since the simulation start.
   *          Returns `0` when the simulation has reached its end time.
   *
   * @throws {@link NumericalError}  on divergence.
   * @throws {@link LifecycleError}  if not in `STARTED` or `RUNNING` state.
   */
  step(): number {
    const ptr = checkedAlloc(this._mod, 8);
    try {
      const rc = this._raw.swmm_engine_step(this.handle, ptr);
      this._rethrowCallbackError();
      if (rc !== 0) {
        raiseForCode(rc, this._raw.swmm_get_last_error_msg(this.handle));
      }
      // Elapsed is in OA days; convert to seconds.
      return this._mod.getValue(ptr, "double") * 86400.0;
    } finally {
      this._mod._free(ptr);
    }
  }

  /**
   * Advance the simulation by `nSteps` routing steps.
   *
   * @param nSteps  Number of routing steps to take.
   * @returns Elapsed simulation time in seconds after the stride.
   *          Returns `0` when the end time has been reached.
   */
  stride(nSteps: number): number {
    const ptr = checkedAlloc(this._mod, 8);
    try {
      const rc = this._raw.swmm_engine_stride(this.handle, nSteps, ptr);
      this._rethrowCallbackError();
      if (rc !== 0) {
        raiseForCode(rc, this._raw.swmm_get_last_error_msg(this.handle));
      }
      return this._mod.getValue(ptr, "double") * 86400.0;
    } finally {
      this._mod._free(ptr);
    }
  }

  /**
   * Finalise the simulation (compute mass balances, etc.).
   *
   * @throws {@link LifecycleError} if not in `RUNNING` or `STARTED` state.
   */
  end(): void {
    const rc = this._raw.swmm_engine_end(this.handle);
    this._rethrowCallbackError();
    if (rc !== 0) {
      raiseForCode(rc, this._raw.swmm_get_last_error_msg(this.handle));
    }
  }

  /**
   * Write the human-readable report to the .rpt file.
   *
   * @throws {@link LifecycleError} if not in `ENDED` state.
   */
  report(): void {
    const rc = this._raw.swmm_engine_report(this.handle);
    this._rethrowCallbackError();
    if (rc !== 0) {
      raiseForCode(rc, this._raw.swmm_get_last_error_msg(this.handle));
    }
  }

  /**
   * Release simulation memory (but keep the handle valid for re-open).
   *
   * @throws {@link LifecycleError} if not in `ENDED` state.
   */
  close(): void {
    this._invalidateViews();
    const rc = this._raw.swmm_engine_close(this.handle);
    this._rethrowCallbackError();
    if (rc !== 0) {
      raiseForCode(rc, this._raw.swmm_get_last_error_msg(this.handle));
    }
  }

  /**
   * Free the engine context. After calling `destroy` this `Solver` instance
   * must not be used.
   */
  destroy(): void {
    if (!this._handle) return;
    this._raw.swmm_engine_destroy(this._handle);
    this._handle = 0;
    for (const slot of this._callbackSlots.values()) this._mod.removeFunction(slot);
    this._callbackSlots.clear();
    this._invalidateViews();
  }

  /**
   * Run a complete simulation from open to close in a single call.
   *
   * The engine is opened, initialised, started, stepped until completion,
   * ended, reported, and closed. The handle remains valid for inspection or
   * re-opening; call {@link Solver.destroy} when done.
   *
   * @param inp         .inp file path (virtual FS).
   * @param rpt         .rpt file path (virtual FS).
   * @param out         .out file path (virtual FS).
   * @param saveResults Write binary output (default `true`).
   * @param pluginLib   Optional plugin library path.
   */
  run(inp: string, rpt: string, out: string, saveResults = true, pluginLib = ""): void {
    let opened = false;
    try {
      this.open(inp, rpt, out, pluginLib);
      opened = true;
      this.initialize();
      this.start(saveResults);
      while (this.step() > 0) {
        /* step until completion */
      }
      this.end();
      this.report();
      this.close();
    } catch (error) {
      try {
        if (opened) this.close();
      } catch (cleanupError) {
        if (error instanceof Error) {
          error.message += `; cleanup also failed: ${String(cleanupError)}`;
        }
      } finally {
        this.destroy();
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // State & time queries
  // -------------------------------------------------------------------------

  /**
   * Current lifecycle state of the engine.
   */
  get state(): EngineState {
    const ptr = checkedAlloc(this._mod, 4);
    try {
      raiseForCode(this._raw.swmm_engine_get_state(this.handle, ptr));
      return this._mod.getValue(ptr, "i32") as EngineState;
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Configured simulation start (`[OPTIONS] START_DATE/TIME`, UTC wall clock). */
  get startDatetime(): Date {
    return this._oadate(this._raw.swmm_options_get_start_date);
  }
  set startDatetime(value: Date) {
    raiseForCode(this._raw.swmm_options_set_start_date(this.handle, datetimeToOadate(value)));
  }

  /** Configured simulation end (`[OPTIONS] END_DATE/TIME`). */
  get endDatetime(): Date {
    return this._oadate(this._raw.swmm_options_get_end_date);
  }
  set endDatetime(value: Date) {
    raiseForCode(this._raw.swmm_options_set_end_date(this.handle, datetimeToOadate(value)));
  }

  /** Configured report start (`[OPTIONS] REPORT_START_DATE/TIME`). */
  get reportStartDatetime(): Date {
    return this._oadate(this._raw.swmm_options_get_report_start);
  }
  set reportStartDatetime(value: Date) {
    raiseForCode(this._raw.swmm_options_set_report_start(this.handle, datetimeToOadate(value)));
  }

  /** Resolved simulation start the engine runs from (`swmm_get_start_time`). */
  get simStartTime(): Date {
    return this._oadate(this._raw.swmm_get_start_time);
  }

  /** Resolved simulation end (`swmm_get_end_time`). */
  get simEndTime(): Date {
    return this._oadate(this._raw.swmm_get_end_time);
  }

  /** @internal Read an OADate through `getter(engine, double*)`. */
  private _oadate(getter: (engine: number, out: number) => number): Date {
    return oadateToDatetime(withDouble(this._mod, (p) => getter(this.handle, p)));
  }

  /**
   * Current simulation date/time.
   * Only valid during and after the simulation loop.
   */
  get currentDatetime(): Date {
    // swmm_get_current_time reports ELAPSED SECONDS since the start, not an
    // OADate (Python's current_datetime makes the same correction).
    const ptr = checkedAlloc(this._mod, 8);
    try {
      raiseForCode(this._raw.swmm_get_current_time(this.handle, ptr));
      const elapsedSeconds = this._mod.getValue(ptr, "double");
      return new Date(this.simStartTime.getTime() + elapsedSeconds * 1000);
    } finally {
      this._mod._free(ptr);
    }
  }

  /**
   * Hydraulic routing time step (seconds).
   * Only valid after {@link Solver.initialize}.
   */
  get routingStep(): number {
    const ptr = checkedAlloc(this._mod, 8);
    try {
      raiseForCode(this._raw.swmm_get_routing_step(this.handle, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /**
   * Flow unit system in use.
   * Only valid after {@link Solver.open}.
   */
  get flowUnits(): FlowUnits {
    const ptr = checkedAlloc(this._mod, 4);
    try {
      raiseForCode(this._raw.swmm_get_flow_units(this.handle, ptr));
      return this._mod.getValue(ptr, "i32") as FlowUnits;
    } finally {
      this._mod._free(ptr);
    }
  }

  // -------------------------------------------------------------------------
  // Error helpers
  // -------------------------------------------------------------------------

  /**
   * Return the last C API error code (0 = no error).
   */
  get lastErrorCode(): number {
    return this._raw.swmm_get_last_error(this.handle);
  }

  /**
   * Return the last C API error message string (empty if no error).
   */
  get lastErrorMessage(): string {
    return this._raw.swmm_get_last_error_msg(this.handle) ?? "";
  }

  /**
   * Translate a numeric error code to a human-readable message string.
   */
  errorMessage(code: number): string {
    return this._raw.swmm_error_message(code) ?? "";
  }

  // -------------------------------------------------------------------------
  // Python Solver members (wave A4)
  // -------------------------------------------------------------------------

  /** Model generation: bumped on open/close; views from an older generation are stale. */
  get generation(): number {
    return this._generation;
  }

  /** @internal The WASM module this solver runs in. */
  get module(): OpenSwmmWasmModule {
    return this._mod;
  }

  /** @internal A structural edit happened: invalidate views, as Python's `_bump_generation`. */
  _bumpGeneration(): void {
    this._invalidateViews();
  }

  /** Snow model, UEB packs, radiation and snow state (Python `solver.snow`). */
  get snow(): Snow {
    return new Snow(this);
  }

  /** The `[AQUIFERS]` entries (Python `solver.aquifers`). */
  get aquifers(): Aquifers {
    return new Aquifers(this);
  }

  /** The `[SNOWPACKS]` entries (Python `solver.snowpacks`). */
  get snowpacks(): Snowpacks {
    return new Snowpacks(this);
  }

  /** The `[POLLUTANTS]` entries (Python `solver.pollutants`). */
  get pollutants(): Pollutants {
    return new Pollutants(this);
  }

  /** Land uses, buildup, washoff and treatment (Python `solver.quality`). */
  get quality(): Quality {
    return new Quality(this);
  }

  /** The `[INITIAL_QUALITY]` rows (Python `solver.initial_quality`). */
  get initialQuality(): InitialQuality {
    return new InitialQuality(this);
  }

  /** Continuity errors and totals (Python `solver.mass_balance`). */
  get massBalance(): MassBalance {
    return new MassBalance(this);
  }

  /**
   * Python's `create()`. The constructor already creates the engine, so this
   * only checks it is alive; a destroyed solver cannot be recreated (make a new one).
   */
  create(): void {
    this._assertAlive();
  }

  /**
   * Open only the model's metadata (no simulation state), for inspecting or
   * editing a model without running it.
   */
  openMetadata(inp: string): void {
    this._invalidateViews();
    const rc = this._raw.swmm_engine_open_metadata(this.handle, inp);
    this._rethrowCallbackError();
    if (rc !== 0) raiseForCode(rc, this._raw.swmm_get_last_error_msg(this.handle));
  }

  /**
   * Open the model only as far as its simulation period: the 2D mesh and the
   * rows that address its cells are skipped, so a large 2D model opens fast.
   */
  openSimulationPeriod(inp: string): void {
    this._invalidateViews();
    const rc = this._raw.swmm_engine_open_simulation_period(this.handle, inp);
    this._rethrowCallbackError();
    if (rc !== 0) raiseForCode(rc, this._raw.swmm_get_last_error_msg(this.handle));
  }

  /**
   * Step until the elapsed time reaches `seconds` (or the run ends).
   * @returns Elapsed seconds actually reached.
   */
  advanceTo(seconds: number): number {
    const ptr = checkedAlloc(this._mod, 8);
    try {
      const rc = this._raw.swmm_engine_advance_to(this.handle, seconds, ptr);
      this._rethrowCallbackError();
      if (rc !== 0) raiseForCode(rc, this._raw.swmm_get_last_error_msg(this.handle));
      return this._mod.HEAPF64[ptr >> 3];
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Step to the end, yielding the elapsed seconds after each routing step. */
  *steps(): Generator<number, void, undefined> {
    for (;;) {
      const elapsed = this.step();
      if (!elapsed) return;
      yield elapsed;
    }
  }

  /**
   * Step until `target`: a `Date` (UTC wall clock) or elapsed seconds from the
   * configured start. Returns the elapsed seconds reached, which is less than
   * the target when the run ends first (0 at the end, like {@link step}).
   */
  until(target: Date | number): number {
    const targetSeconds =
      target instanceof Date ? (target.getTime() - this.startDatetime.getTime()) / 1000 : target;
    if (typeof targetSeconds !== "number" || Number.isNaN(targetSeconds)) {
      throw new TypeError("until(target) expects a Date or elapsed seconds");
    }
    const now = this.elapsed;
    if (targetSeconds <= now) return now;
    for (;;) {
      const elapsed = this.step();
      if (!elapsed || elapsed >= targetSeconds) return elapsed;
    }
  }

  /** Elapsed simulation time in seconds. */
  get elapsed(): number {
    return withDouble(this._mod, (p) => this._raw.swmm_engine_get_elapsed_seconds(this.handle, p));
  }

  /** Errors recorded while opening the model (lenient open keeps going). */
  get openErrors(): string[] {
    const h = this.handle;
    const n = this._raw.swmm_get_error_count(h);
    return Array.from({ length: n }, (_, i) => this._raw.swmm_get_error_at(h, i) ?? "");
  }

  /** Warnings recorded while opening or writing the model. */
  get openWarnings(): string[] {
    const h = this.handle;
    const n = this._raw.swmm_get_warning_count(h);
    return Array.from({ length: n }, (_, i) => this._raw.swmm_get_warning_at(h, i) ?? "");
  }

  /** Coordinate reference system of the model (empty when none). */
  get crs(): string {
    return withCString(this._mod, 1024, (buf, len) =>
      this._raw.swmm_get_crs(this.handle, buf, len),
    );
  }

  /** True while the current time falls between `[EVENTS]` periods. */
  get isBetweenEvents(): boolean {
    return withInt(this._mod, (p) => this._raw.swmm_is_between_events(this.handle, p)) !== 0;
  }

  /** Skip steady-state periods (`[OPTIONS] SKIP_STEADY_STATE`). */
  get steadyStateSkip(): boolean {
    return withInt(this._mod, (p) => this._raw.swmm_get_steady_state_skip(this.handle, p)) !== 0;
  }
  set steadyStateSkip(value: boolean) {
    raiseForCode(this._raw.swmm_set_steady_state_skip(this.handle, value ? 1 : 0));
  }

  /** Number of `[EVENTS]` entries. */
  get eventCount(): number {
    return withInt(this._mod, (p) => this._raw.swmm_get_event_count(this.handle, p));
  }

  /** `"US"` (CFS, GPM, MGD) or `"SI"` (CMS, LPS, MLD). */
  get unitSystem(): "US" | "SI" {
    return withInt(this._mod, (p) => this._raw.swmm_get_unit_system(this.handle, p)) === 1
      ? "SI"
      : "US";
  }

  /** Write the model to an `.inp` file (Python `write`). */
  write(path: string): void {
    this.writeModel(path);
  }

  /** Write the model through an output plugin (`""` = built-in INP writer). */
  writeWithPlugin(path: string, outputPluginId = ""): void {
    this.writeModel(path, outputPluginId);
  }

  /**
   * Write FULL, OpenSWMM-legacy or stock EPA SWMM 5 input ({@link InpProfile}).
   * Conversion warnings appear in {@link openWarnings}; the model is unchanged.
   */
  writeCompat(path: string, profile: InpProfile): void {
    const h = this.handle;
    const rc = this._raw.swmm_model_write_compat(h, path, profile);
    this._rethrowCallbackError();
    if (rc !== 0) raiseForCode(rc, this._raw.swmm_get_last_error_msg(h));
  }

  /**
   * Write the built-in INP outputs to staging paths: `mapper(finalPath, kind)`
   * (kind 0 = model, 1 = mesh, 2 = component configuration) returns where to
   * write each output, or `null` to refuse it. References stay relative to
   * `finalPath`; publishing the staged files is up to the caller. The mapper
   * must not use the engine.
   */
  writeStaged(finalPath: string, mapper: (finalPath: string, kind: number) => string | null): void {
    const mod = this._mod;
    let current = 0;
    let failure: unknown = undefined;
    const release = () => {
      if (current) mod._free(current);
      current = 0;
    };
    const slot = mod.addFunction((_user: number, pathPtr: number, kind: number) => {
      release();
      if (failure !== undefined) return 0;
      try {
        const staged = mapper(mod.UTF8ToString(pathPtr), kind);
        if (!staged) return 0;
        const bytes = mod.lengthBytesUTF8(staged) + 1;
        current = checkedAlloc(mod, bytes);
        mod.stringToUTF8(staged, current, bytes);
        return current;
      } catch (err) {
        failure = err;
        return 0;
      }
    }, "iiii");
    try {
      const h = this.handle;
      const rc = this._raw.swmm_model_write_staged(h, finalPath, slot, 0);
      if (failure !== undefined) throw failure;
      this._rethrowCallbackError();
      if (rc !== 0) raiseForCode(rc, this._raw.swmm_get_last_error_msg(h));
    } finally {
      release();
      mod.removeFunction(slot);
    }
  }

  /** Open a runoff interface file to save runoff results into. */
  openRunoffInterfaceWrite(path: string): void {
    raiseForCode(this._raw.swmm_runoff_iface_open_write(this.handle, path));
  }

  /** Open a runoff interface file to route previously saved runoff. */
  openRunoffInterfaceRead(path: string): void {
    raiseForCode(this._raw.swmm_runoff_iface_open_read(this.handle, path));
  }

  /** Save the current runoff step (`dt` in seconds) to the interface file. */
  saveRunoffStep(dt: number): void {
    raiseForCode(this._raw.swmm_runoff_iface_save_step(this.handle, dt));
  }

  /** Read the next runoff step; false when the file has no more data. */
  readRunoffStep(): boolean {
    return withInt(this._mod, (p) => this._raw.swmm_runoff_iface_read_step(this.handle, p)) !== 0;
  }

  /** Close the runoff interface file. */
  closeRunoffInterface(): void {
    raiseForCode(this._raw.swmm_runoff_iface_close(this.handle));
  }

  // ---- callbacks ------------------------------------------------------------
  //
  // A callback must not throw across the engine's C++ frames, so each one is
  // wrapped: its first error is kept, later callbacks of the same native call
  // are skipped, and the error is rethrown when that call returns. `null`
  // removes the callback. Callbacks may read the model; they must not change
  // it or call back into stepping.

  /** @internal Rethrow the first error a callback raised during the last native call. */
  private _rethrowCallbackError(): void {
    if (this._callbackError !== undefined) {
      const err = this._callbackError;
      this._callbackError = undefined;
      throw err;
    }
  }

  /** @internal Install (or with `fn === null`, remove) one kind of callback. */
  private _setCallback(
    kind: string,
    setter: (engine: number, fn: number, user: number) => number,
    signature: string,
    fn: ((...args: number[]) => void) | null,
  ): void {
    const h = this.handle;
    const previous = this._callbackSlots.get(kind);
    let slot = 0;
    if (fn) {
      slot = this._mod.addFunction((...args: number[]) => {
        if (this._callbackError !== undefined) return;
        try {
          fn(...args);
        } catch (err) {
          this._callbackError = err;
        }
      }, signature);
    }
    const rc = setter(h, slot, 0);
    if (rc !== 0) {
      if (slot) this._mod.removeFunction(slot);
      raiseForCode(rc, this._raw.swmm_get_last_error_msg(h));
    }
    if (previous) this._mod.removeFunction(previous);
    if (slot) this._callbackSlots.set(kind, slot);
    else this._callbackSlots.delete(kind);
  }

  /** `callback(elapsedFraction)` as the run progresses, fraction in [0, 1]. */
  setProgressCallback(callback: ((elapsedFraction: number) => void) | null): void {
    this._setCallback(
      "progress",
      this._raw.swmm_set_progress_callback,
      CALLBACK_SIGNATURES.SWMM_ProgressCallback,
      callback && ((_engine, fraction) => callback(fraction)),
    );
  }

  /** `callback(code, message)` for each engine warning. */
  setWarningCallback(callback: ((code: number, message: string) => void) | null): void {
    this._setCallback(
      "warning",
      this._raw.swmm_set_warning_callback,
      CALLBACK_SIGNATURES.SWMM_WarningCallback,
      callback &&
        ((_engine, code, message) =>
          callback(code, message ? this._mod.UTF8ToString(message) : "")),
    );
  }

  /** `callback(simTime, dt)` before each routing step. */
  setStepBeginCallback(callback: ((simTime: number, dt: number) => void) | null): void {
    this._setCallback(
      "stepBegin",
      this._raw.swmm_set_step_begin_callback,
      CALLBACK_SIGNATURES.SWMM_StepBeginCallback,
      callback && ((_engine, simTime, dt) => callback(simTime, dt)),
    );
  }

  /** `callback(simTime, dt)` after each routing step. */
  setStepEndCallback(callback: ((simTime: number, dt: number) => void) | null): void {
    this._setCallback(
      "stepEnd",
      this._raw.swmm_set_step_end_callback,
      CALLBACK_SIGNATURES.SWMM_StepEndCallback,
      callback && ((_engine, simTime, dt) => callback(simTime, dt)),
    );
  }

  /** `callback(phase, startSeconds, endSeconds)` for each engine phase of a step. */
  setPhaseCallback(
    callback: ((phase: number, startSeconds: number, endSeconds: number) => void) | null,
  ): void {
    this._setCallback(
      "phase",
      this._raw.swmm_set_phase_callback,
      CALLBACK_SIGNATURES.SWMM_PhaseCallback,
      callback && ((_engine, phase, start, end) => callback(phase, start, end)),
    );
  }

  // -------------------------------------------------------------------------
  // Explicit resource management (TC39 proposal Stage 3)
  // -------------------------------------------------------------------------

  /**
   * Dispose of the engine context (alias for {@link Solver.destroy}).
   *
   * Enables use of `await using solver = new Solver(mod)` in TypeScript 5.2+
   * environments that support the TC39 Explicit Resource Management proposal.
   */
  [Symbol.dispose](): void {
    this.destroy();
  }
}

// =============================================================================
// Module-level functions (Python `abi_tag`, `run`, `run_with_callback`)
// =============================================================================

/** The engine's ABI tag, the identity plugins and bindings are checked against. */
export function abiTag(mod: OpenSwmmWasmModule): string {
  return rawOf(mod).swmm_engine_abi_tag() ?? "";
}

/** Run a whole simulation from files in the virtual filesystem. */
export function run(
  mod: OpenSwmmWasmModule,
  inp: string,
  rpt: string | null = null,
  out: string | null = null,
  { pluginLib = null }: { pluginLib?: string | null } = {},
): void {
  raiseForCode(rawOf(mod).swmm_engine_run(inp, rpt, out, pluginLib));
}

/**
 * {@link run} with `callback(elapsedFraction)` as the run progresses. An error
 * the callback throws is rethrown when the run returns.
 */
export function runWithCallback(
  mod: OpenSwmmWasmModule,
  inp: string,
  rpt: string | null = null,
  out: string | null = null,
  callback: ((elapsedFraction: number) => void) | null = null,
  { pluginLib = null }: { pluginLib?: string | null } = {},
): void {
  let failure: unknown = undefined;
  const slot = callback
    ? mod.addFunction((_engine: number, fraction: number) => {
        if (failure !== undefined) return;
        try {
          callback(fraction);
        } catch (err) {
          failure = err;
        }
      }, CALLBACK_SIGNATURES.SWMM_ProgressCallback)
    : 0;
  try {
    const rc = rawOf(mod).swmm_engine_run_with_callback(inp, rpt, out, pluginLib, slot, 0);
    if (failure !== undefined) throw failure;
    raiseForCode(rc);
  } finally {
    if (slot) mod.removeFunction(slot);
  }
}
