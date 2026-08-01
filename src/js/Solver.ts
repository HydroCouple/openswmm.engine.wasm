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
 * gages, controls, and forcing.
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
 * @license  MIT
 */

import { EngineState, FlowUnits } from "./enums.js";
import { EngineError, raiseForCode } from "./errors.js";
import { Nodes } from "./Nodes.js";
import { Links } from "./Links.js";
import { Subcatchments } from "./Subcatchments.js";
import { Gages } from "./Gages.js";
import { Controls } from "./Controls.js";
import { Forcing } from "./Forcing.js";
import { type OpenSwmmWasmModule, oadateToDate } from "./types.js";

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

  /**
   * Opaque engine handle (integer pointer into WASM heap).
   *
   * This is the value passed as the first argument to every C API call.
   * Reading `handle` from JavaScript is possible but manipulating it
   * directly is unsupported.
   */
  readonly handle: number;

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

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  /**
   * Create a new engine context and domain collection wrappers.
   *
   * @param mod  The Emscripten module returned by `createOpenSwmmModule()`.
   * @throws {@link EngineError} if the engine context cannot be allocated.
   */
  constructor(mod: OpenSwmmWasmModule) {
    this._mod = mod;
    const h = mod.swmm_engine_create();
    if (!h) throw new EngineError(7, "swmm_engine_create() returned NULL");
    this.handle = h;
    this.nodes = new Nodes(mod, h);
    this.links = new Links(mod, h);
    this.subcatchments = new Subcatchments(mod, h);
    this.gages = new Gages(mod, h);
    this.controls = new Controls(mod, h);
    this.forcing = new Forcing(mod, h);
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
    this._mod.swmm_engine_set_lenient_open(this.handle, on ? 1 : 0);
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
    const rc = this._mod.swmm_engine_open(this.handle, inp, rpt, out, pluginLib);
    if (rc !== 0) {
      const msg = this._mod.swmm_get_last_error_msg(this.handle);
      raiseForCode(rc, msg);
    }
    // Bump generation so any stale Node/Link/… wrappers from a previous open
    // will throw StaleObjectError.
    this.nodes.generation++;
    this.links.generation++;
    this.subcatchments.generation++;
    this.gages.generation++;
  }

  /**
   * Apply initial conditions to the opened model.
   *
   * @throws {@link LifecycleError} if not in `OPENED` state.
   */
  initialize(): void {
    const rc = this._mod.swmm_engine_initialize(this.handle);
    if (rc !== 0) {
      raiseForCode(rc, this._mod.swmm_get_last_error_msg(this.handle));
    }
  }

  /**
   * Prepare the solver for time-stepping.
   *
   * @param saveResults  Write results to the binary output file (default: `true`).
   * @throws {@link LifecycleError} if not in `INITIALIZED` state.
   */
  start(saveResults = true): void {
    const rc = this._mod.swmm_engine_start(this.handle, saveResults ? 1 : 0);
    if (rc !== 0) {
      raiseForCode(rc, this._mod.swmm_get_last_error_msg(this.handle));
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
    const ptr = this._mod._malloc(8);
    try {
      const rc = this._mod.swmm_engine_step(this.handle, ptr);
      if (rc !== 0) {
        raiseForCode(rc, this._mod.swmm_get_last_error_msg(this.handle));
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
    const ptr = this._mod._malloc(8);
    try {
      const rc = this._mod.swmm_engine_stride(this.handle, nSteps, ptr);
      if (rc !== 0) {
        raiseForCode(rc, this._mod.swmm_get_last_error_msg(this.handle));
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
    const rc = this._mod.swmm_engine_end(this.handle);
    if (rc !== 0) {
      raiseForCode(rc, this._mod.swmm_get_last_error_msg(this.handle));
    }
  }

  /**
   * Write the human-readable report to the .rpt file.
   *
   * @throws {@link LifecycleError} if not in `ENDED` state.
   */
  report(): void {
    const rc = this._mod.swmm_engine_report(this.handle);
    if (rc !== 0) {
      raiseForCode(rc, this._mod.swmm_get_last_error_msg(this.handle));
    }
  }

  /**
   * Release simulation memory (but keep the handle valid for re-open).
   *
   * @throws {@link LifecycleError} if not in `ENDED` state.
   */
  close(): void {
    const rc = this._mod.swmm_engine_close(this.handle);
    if (rc !== 0) {
      raiseForCode(rc, this._mod.swmm_get_last_error_msg(this.handle));
    }
  }

  /**
   * Free the engine context. After calling `destroy` this `Solver` instance
   * must not be used.
   */
  destroy(): void {
    this._mod.swmm_engine_destroy(this.handle);
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
  run(
    inp: string,
    rpt: string,
    out: string,
    saveResults = true,
    pluginLib = "",
  ): void {
    this.open(inp, rpt, out, pluginLib);
    this.initialize();
    this.start(saveResults);
    while (this.step() > 0) {
      /* step until completion */
    }
    this.end();
    this.report();
    this.close();
  }

  // -------------------------------------------------------------------------
  // State & time queries
  // -------------------------------------------------------------------------

  /**
   * Current lifecycle state of the engine.
   */
  get state(): EngineState {
    const ptr = this._mod._malloc(4);
    try {
      raiseForCode(this._mod.swmm_engine_get_state(this.handle, ptr));
      return this._mod.getValue(ptr, "i32") as EngineState;
    } finally {
      this._mod._free(ptr);
    }
  }

  /**
   * Simulation start date/time.
   * Only valid after {@link Solver.open}.
   */
  get startDatetime(): Date {
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_get_start_time(this.handle, ptr));
      return oadateToDate(this._mod.getValue(ptr, "double"));
    } finally {
      this._mod._free(ptr);
    }
  }

  /**
   * Simulation end date/time.
   * Only valid after {@link Solver.open}.
   */
  get endDatetime(): Date {
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_get_end_time(this.handle, ptr));
      return oadateToDate(this._mod.getValue(ptr, "double"));
    } finally {
      this._mod._free(ptr);
    }
  }

  /**
   * Current simulation date/time.
   * Only valid during and after the simulation loop.
   */
  get currentDatetime(): Date {
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_get_current_time(this.handle, ptr));
      return oadateToDate(this._mod.getValue(ptr, "double"));
    } finally {
      this._mod._free(ptr);
    }
  }

  /**
   * Hydraulic routing time step (seconds).
   * Only valid after {@link Solver.initialize}.
   */
  get routingStep(): number {
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_get_routing_step(this.handle, ptr));
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
    const ptr = this._mod._malloc(4);
    try {
      raiseForCode(this._mod.swmm_get_flow_units(this.handle, ptr));
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
    return this._mod.swmm_get_last_error(this.handle);
  }

  /**
   * Return the last C API error message string (empty if no error).
   */
  get lastErrorMessage(): string {
    return this._mod.swmm_get_last_error_msg(this.handle) ?? "";
  }

  /**
   * Translate a numeric error code to a human-readable message string.
   */
  errorMessage(code: number): string {
    return this._mod.swmm_error_message(code) ?? "";
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
