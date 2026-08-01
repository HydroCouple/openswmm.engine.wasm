/**
 * @file types.ts
 * @brief TypeScript type declarations for the Emscripten-generated WASM module.
 *
 * @details Declares the shape of the object returned by `createOpenSwmmModule()`
 * so that `Solver` and the domain collection classes can call into the WASM
 * engine with full type safety.
 *
 * These types are structural (duck-typed) interfaces — the actual object is
 * produced at runtime by the Emscripten glue code.
 *
 * @author   Caleb Buahin <caleb.buahin@gmail.com>
 * @copyright Copyright (c) 2026 Caleb Buahin. All rights reserved.
 * @license  MIT
 */

// =============================================================================
// Emscripten Module interface
// =============================================================================

/**
 * Low-level Emscripten filesystem API exposed for .inp/.rpt/.out file I/O.
 */
export interface EmscriptenFS {
  mkdir(path: string): void;
  writeFile(path: string, data: Uint8Array | string): void;
  readFile(path: string, opts?: { encoding: "binary" }): Uint8Array;
  readFile(path: string, opts: { encoding: "utf8" }): string;
  unlink(path: string): void;
}

/**
 * Minimal subset of the Emscripten module API used by the binding layer.
 *
 * The full generated module exposes many more symbols; only the ones accessed
 * by the TypeScript wrappers are declared here.
 */
export interface OpenSwmmWasmModule {
  /** Emscripten virtual filesystem. */
  readonly FS: EmscriptenFS;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  /** Create a new engine context. Returns an opaque integer handle (pointer). */
  swmm_engine_create(): number;

  /**
   * Open an engine context from files already written to the virtual FS.
   * @returns 0 on success, non-zero error code on failure.
   */
  swmm_engine_open(
    engine: number,
    inp: string,
    rpt: string,
    out: string,
    pluginLib: string,
  ): number;

  /**
   * Apply initial conditions.
   * @returns 0 on success.
   */
  swmm_engine_initialize(engine: number): number;

  /**
   * Prepare the solver for time-stepping.
   * @param saveResults Pass 1 to write binary output; 0 otherwise.
   * @returns 0 on success.
   */
  swmm_engine_start(engine: number, saveResults: number): number;

  /**
   * Advance the simulation by one routing step.
   * The out-parameter `elapsedPtr` is a pre-allocated `double*` on the WASM
   * heap (allocate with `_malloc(8)` and free after).
   * @returns 0 on success.
   */
  swmm_engine_step(engine: number, elapsedPtr: number): number;

  /**
   * Advance the simulation by `n` routing steps.
   * @returns 0 on success.
   */
  swmm_engine_stride(engine: number, nSteps: number, elapsedPtr: number): number;

  /**
   * Finalise the simulation.
   * @returns 0 on success.
   */
  swmm_engine_end(engine: number): number;

  /**
   * Write the report file.
   * @returns 0 on success.
   */
  swmm_engine_report(engine: number): number;

  /**
   * Release resources (but keep the handle valid for `destroy`).
   * @returns 0 on success.
   */
  swmm_engine_close(engine: number): number;

  /** Free the engine context. */
  swmm_engine_destroy(engine: number): void;

  /**
   * Set lenient-open mode (continue past non-fatal parse errors).
   */
  swmm_engine_set_lenient_open(engine: number, on: number): void;

  // -------------------------------------------------------------------------
  // State / time / units
  // -------------------------------------------------------------------------
  swmm_engine_get_state(engine: number, statePtr: number): number;
  swmm_get_start_time(engine: number, tPtr: number): number;
  swmm_get_end_time(engine: number, tPtr: number): number;
  swmm_get_current_time(engine: number, tPtr: number): number;
  swmm_get_routing_step(engine: number, dtPtr: number): number;
  swmm_get_flow_units(engine: number, unitsPtr: number): number;
  swmm_get_unit_system(engine: number, sysPtr: number): number;

  // -------------------------------------------------------------------------
  // Error reporting
  // -------------------------------------------------------------------------
  swmm_get_last_error(engine: number): number;
  swmm_get_last_error_msg(engine: number): string;
  swmm_error_message(code: number): string;
  swmm_get_error_count(engine: number): number;
  swmm_get_warning_count(engine: number): number;

  // -------------------------------------------------------------------------
  // Nodes
  // -------------------------------------------------------------------------
  swmm_node_count(engine: number): number;
  swmm_node_index(engine: number, id: string): number;
  swmm_node_id(engine: number, idx: number): string;
  swmm_node_get_type(engine: number, idx: number, typePtr: number): number;
  swmm_node_get_depth(engine: number, idx: number, valPtr: number): number;
  swmm_node_set_depth(engine: number, idx: number, val: number): number;
  swmm_node_get_head(engine: number, idx: number, valPtr: number): number;
  swmm_node_get_volume(engine: number, idx: number, valPtr: number): number;
  swmm_node_get_lateral_inflow(engine: number, idx: number, valPtr: number): number;
  swmm_node_set_lateral_inflow(engine: number, idx: number, val: number): number;
  swmm_node_get_overflow(engine: number, idx: number, valPtr: number): number;
  swmm_node_get_inflow(engine: number, idx: number, valPtr: number): number;
  swmm_node_get_losses(engine: number, idx: number, valPtr: number): number;
  swmm_node_get_outflow(engine: number, idx: number, valPtr: number): number;
  swmm_node_get_invert_elev(engine: number, idx: number, valPtr: number): number;
  swmm_node_set_invert_elev(engine: number, idx: number, val: number): number;
  swmm_node_get_max_depth(engine: number, idx: number, valPtr: number): number;
  swmm_node_set_max_depth(engine: number, idx: number, val: number): number;
  swmm_node_set_head_boundary(engine: number, idx: number, head: number): number;
  swmm_node_get_stat_max_depth(engine: number, idx: number, valPtr: number): number;
  swmm_node_get_stat_max_overflow(engine: number, idx: number, valPtr: number): number;
  swmm_node_get_stat_vol_flooded(engine: number, idx: number, valPtr: number): number;
  swmm_node_get_stat_time_flooded(engine: number, idx: number, valPtr: number): number;

  // -------------------------------------------------------------------------
  // Links
  // -------------------------------------------------------------------------
  swmm_link_count(engine: number): number;
  swmm_link_index(engine: number, id: string): number;
  swmm_link_id(engine: number, idx: number): string;
  swmm_link_get_type(engine: number, idx: number, typePtr: number): number;
  swmm_link_get_flow(engine: number, idx: number, valPtr: number): number;
  swmm_link_set_flow(engine: number, idx: number, val: number): number;
  swmm_link_get_depth(engine: number, idx: number, valPtr: number): number;
  swmm_link_get_velocity(engine: number, idx: number, valPtr: number): number;
  swmm_link_get_capacity(engine: number, idx: number, valPtr: number): number;
  swmm_link_get_volume(engine: number, idx: number, valPtr: number): number;
  swmm_link_get_control_setting(engine: number, idx: number, valPtr: number): number;
  swmm_link_set_control_setting(engine: number, idx: number, val: number): number;
  swmm_link_get_target_setting(engine: number, idx: number, valPtr: number): number;
  swmm_link_set_target_setting(engine: number, idx: number, val: number): number;
  swmm_link_get_closed(engine: number, idx: number, valPtr: number): number;
  swmm_link_set_closed(engine: number, idx: number, val: number): number;
  swmm_link_get_from_node(engine: number, idx: number, valPtr: number): number;
  swmm_link_get_to_node(engine: number, idx: number, valPtr: number): number;

  // -------------------------------------------------------------------------
  // Subcatchments
  // -------------------------------------------------------------------------
  swmm_subcatch_count(engine: number): number;
  swmm_subcatch_index(engine: number, id: string): number;
  swmm_subcatch_id(engine: number, idx: number): string;
  swmm_subcatch_get_runoff(engine: number, idx: number, valPtr: number): number;
  swmm_subcatch_get_area(engine: number, idx: number, valPtr: number): number;
  swmm_subcatch_get_imperv_pct(engine: number, idx: number, valPtr: number): number;
  swmm_subcatch_get_width(engine: number, idx: number, valPtr: number): number;
  swmm_subcatch_get_slope(engine: number, idx: number, valPtr: number): number;
  swmm_subcatch_get_outlet(engine: number, idx: number, valPtr: number): number;
  swmm_subcatch_get_gage(engine: number, idx: number, valPtr: number): number;

  // -------------------------------------------------------------------------
  // Rain Gages
  // -------------------------------------------------------------------------
  swmm_gage_count(engine: number): number;
  swmm_gage_index(engine: number, id: string): number;
  swmm_gage_id(engine: number, idx: number): string;
  swmm_gage_get_rainfall(engine: number, idx: number, valPtr: number): number;
  swmm_gage_set_rainfall(engine: number, idx: number, val: number): number;
  swmm_gage_get_rain_type(engine: number, idx: number, valPtr: number): number;
  swmm_gage_get_data_source(engine: number, idx: number, valPtr: number): number;
  swmm_gage_get_scale_factor(engine: number, idx: number, valPtr: number): number;
  swmm_gage_set_scale_factor(engine: number, idx: number, val: number): number;
  swmm_gage_get_rain_interval(engine: number, idx: number, valPtr: number): number;
  swmm_gage_get_snow_factor(engine: number, idx: number, valPtr: number): number;

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------
  swmm_control_count(engine: number): number;
  swmm_control_get_rule(engine: number, idx: number, buf: number, buflen: number): number;
  swmm_control_get_id(engine: number, idx: number, buf: number, buflen: number): number;
  swmm_control_add_rule(engine: number, ruleText: string): number;
  swmm_control_remove_rule(engine: number, idx: number): number;
  swmm_control_clear_rules(engine: number): number;
  swmm_control_set_link_setting(engine: number, linkIdx: number, setting: number): number;
  swmm_control_set_link_status(engine: number, linkIdx: number, status: number): number;

  // -------------------------------------------------------------------------
  // Forcing
  // -------------------------------------------------------------------------
  swmm_forcing_node_lat_inflow(
    engine: number, nodeIdx: number, value: number, mode: number
  ): number;
  swmm_forcing_node_head_boundary(
    engine: number, nodeIdx: number, value: number, mode: number
  ): number;
  swmm_forcing_link_flow(
    engine: number, linkIdx: number, value: number, mode: number
  ): number;
  swmm_forcing_link_setting(
    engine: number, linkIdx: number, value: number, mode: number
  ): number;
  swmm_forcing_subcatch_rainfall(
    engine: number, scIdx: number, value: number, mode: number
  ): number;
  swmm_forcing_gage_rainfall(
    engine: number, gageIdx: number, value: number, mode: number
  ): number;
  swmm_forcing_clear(engine: number, type: number, idx: number): number;
  swmm_forcing_clear_all(engine: number): number;

  // -------------------------------------------------------------------------
  // Model builder — lifecycle
  // -------------------------------------------------------------------------
  /** Create an empty engine in BUILDING state (no .inp file required). */
  swmm_engine_new(): number;
  /** Validate model topology without changing state. */
  swmm_validate_model(engine: number): number;
  /** Finalize a programmatically-built model. Transitions to INITIALIZED. */
  swmm_finalize_model(engine: number): number;
  /** Write the current model state to a SWMM .inp file. */
  swmm_model_write(engine: number, path: string): number;
  /** Write the current model state via a named writer plugin. */
  swmm_model_write_with_plugin(engine: number, path: string, pluginId: string): number;

  // -------------------------------------------------------------------------
  // Model builder — object add / pop
  // -------------------------------------------------------------------------
  swmm_node_add(engine: number, id: string, type: number): number;
  swmm_node_pop_last(engine: number, id: string): number;
  swmm_link_add(engine: number, id: string, type: number): number;
  swmm_link_pop_last(engine: number, id: string): number;
  swmm_subcatch_add(engine: number, id: string): number;
  swmm_gage_add(engine: number, id: string): number;

  // -------------------------------------------------------------------------
  // Model builder — link geometry setters
  // -------------------------------------------------------------------------
  swmm_link_set_nodes(engine: number, idx: number, fromNode: number, toNode: number): number;
  swmm_link_set_length(engine: number, idx: number, length: number): number;
  swmm_link_set_roughness(engine: number, idx: number, n: number): number;
  swmm_link_set_xsect(
    engine: number, idx: number, shape: number,
    geom1: number, geom2: number, geom3: number, geom4: number,
  ): number;

  // -------------------------------------------------------------------------
  // Model builder — [TITLE] section
  // -------------------------------------------------------------------------
  /** @param countPtr Pre-allocated int* on the WASM heap. */
  swmm_title_get_count(engine: number, countPtr: number): number;
  swmm_title_get_line(engine: number, index: number): string;
  swmm_title_add_line(engine: number, line: string): number;
  swmm_title_set(engine: number, text: string): number;
  swmm_title_clear(engine: number): number;

  // -------------------------------------------------------------------------
  // Model builder — [OPTIONS] / CRS
  // -------------------------------------------------------------------------
  swmm_options_get(engine: number, key: string): string;
  swmm_options_set(engine: number, key: string, value: string): number;
  swmm_options_get_ext(engine: number, key: string): string;
  swmm_options_set_ext(engine: number, key: string, value: string): number;
  swmm_get_crs(engine: number): string;

  // -------------------------------------------------------------------------
  // Model builder — typed date/time options (OADate doubles)
  // -------------------------------------------------------------------------
  swmm_options_get_start_date(engine: number, tPtr: number): number;
  swmm_options_set_start_date(engine: number, t: number): number;
  swmm_options_get_end_date(engine: number, tPtr: number): number;
  swmm_options_set_end_date(engine: number, t: number): number;
  swmm_options_get_report_start(engine: number, tPtr: number): number;
  swmm_options_set_report_start(engine: number, t: number): number;

  // -------------------------------------------------------------------------
  // Model builder — user flags (schema-level)
  // -------------------------------------------------------------------------
  swmm_userflag_get_bool(engine: number, name: string, valPtr: number): number;
  swmm_userflag_get_int(engine: number, name: string, valPtr: number): number;
  swmm_userflag_get_real(engine: number, name: string, valPtr: number): number;
  swmm_userflag_set_bool(engine: number, name: string, value: number): number;
  swmm_userflag_set_int(engine: number, name: string, value: number): number;
  swmm_userflag_set_real(engine: number, name: string, value: number): number;
  /** @param countPtr Pre-allocated int* on the WASM heap. */
  swmm_userflag_def_count(engine: number, countPtr: number): number;
  /**
   * @param nameBuf  WASM heap pointer to name output buffer.
   * @param typePtr  WASM heap pointer to int for type output.
   * @param descBuf  WASM heap pointer to description output buffer.
   */
  swmm_userflag_def_get(
    engine: number, index: number,
    nameBuf: number, nameBufLen: number,
    typePtr: number,
    descBuf: number, descBufLen: number,
  ): number;
  swmm_userflag_define(engine: number, name: string, type: number, description: string): number;
  swmm_userflag_undefine(engine: number, name: string): number;

  // -------------------------------------------------------------------------
  // Model builder — user flag per-object values
  // -------------------------------------------------------------------------
  /**
   * @param buf       WASM heap pointer to value output buffer.
   * @param foundPtr  WASM heap pointer to int (1 = found, 0 = not found).
   */
  swmm_userflag_value_get(
    engine: number,
    objType: string, objName: string, flagName: string,
    buf: number, bufLen: number,
    foundPtr: number,
  ): number;
  swmm_userflag_value_set(
    engine: number,
    objType: string, objName: string, flagName: string,
    value: string,
  ): number;
  swmm_userflag_value_clear(
    engine: number,
    objType: string, objName: string, flagName: string,
  ): number;

  // -------------------------------------------------------------------------
  // Model builder — [PLUGINS] section
  // -------------------------------------------------------------------------
  /** @param countPtr Pre-allocated int* on the WASM heap. */
  swmm_plugins_count(engine: number, countPtr: number): number;
  /**
   * @param pathBuf  WASM heap pointer to path output buffer.
   * @param argsBuf  WASM heap pointer to args output buffer.
   */
  swmm_plugin_get(
    engine: number, idx: number,
    pathBuf: number, pathSz: number,
    argsBuf: number, argsSz: number,
  ): number;
  swmm_plugin_set(engine: number, pathOrId: string, args: string): number;
  swmm_plugin_remove(engine: number, pathOrId: string): number;

  // -------------------------------------------------------------------------
  // Model builder — [FILES] section
  // -------------------------------------------------------------------------
  swmm_files_get(engine: number, key: string): string;
  swmm_files_set(engine: number, key: string, value: string): number;

  // -------------------------------------------------------------------------
  // Model builder — external file path slots (IO-9)
  // -------------------------------------------------------------------------
  /**
   * @param absBuf   WASM heap pointer to absolute-path output buffer.
   * @param origBuf  WASM heap pointer to original-token output buffer.
   */
  swmm_file_path_get(
    engine: number, role: number, owner: string,
    absBuf: number, absSz: number,
    origBuf: number, origSz: number,
  ): number;
  swmm_file_path_set(
    engine: number, role: number, owner: string, newPath: string,
  ): number;

  // -------------------------------------------------------------------------
  // WASM heap helpers (always present in every Emscripten module)
  // -------------------------------------------------------------------------
  _malloc(size: number): number;
  _free(ptr: number): void;
  getValue(ptr: number, type: string): number;
  setValue(ptr: number, value: number, type: string): void;
  UTF8ToString(ptr: number, maxBytes?: number): string;
  stringToUTF8(str: string, outPtr: number, maxBytesToWrite: number): void;
}

// =============================================================================
// OADate helpers
// =============================================================================

/**
 * OADate epoch: 30 December 1899 00:00:00 UTC.
 *
 * The engine stores all timestamps as OA (OLE Automation) dates — decimal
 * days since this epoch. Values before 1 March 1900 require a special
 * correction because the original Lotus 1-2-3 / Excel bug treated 1900 as a
 * leap year; the engine already corrects for this, so we handle it too.
 */
const OA_EPOCH_MS = Date.UTC(1899, 11, 30); // 30 Dec 1899

/**
 * Convert an OADate (decimal days since 30 Dec 1899) to a JavaScript `Date`.
 *
 * @param oadate OADate value from the engine.
 */
export function oadateToDate(oadate: number): Date {
  return new Date(OA_EPOCH_MS + oadate * 86400000);
}

/**
 * Convert a JavaScript `Date` to an OADate.
 *
 * @param date JavaScript `Date` object.
 */
export function dateToOadate(date: Date): number {
  return (date.getTime() - OA_EPOCH_MS) / 86400000;
}
