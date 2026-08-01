/**
 * @file ModelBuilder.ts
 * @brief Programmatic model builder for the OpenSWMM WASM bindings.
 *
 * @details Mirrors the Python `_model.pyi` specification. `ModelBuilder`
 * creates a SWMM model entirely through the API without requiring a `.inp`
 * file:
 *
 * ```
 * new → addNode / addLink / … → validate → finalize → toSolver
 * ```
 *
 * The underlying engine starts in `BUILDING` state. After {@link ModelBuilder.finalize}
 * it transitions to `INITIALIZED`. Calling {@link ModelBuilder.toSolver} hands
 * the engine handle to a {@link Solver}; the `ModelBuilder` instance must not
 * be used thereafter.
 *
 * ### Example
 * ```ts
 * import createOpenSwmmModule from "./dist/openswmm_engine.js";
 * import { ModelBuilder, NodeType, LinkType, XSectShape } from "@hydrocouple/openswmm-engine-wasm";
 *
 * const mod = await createOpenSwmmModule();
 * const builder = new ModelBuilder(mod);
 *
 * builder.setOption("FLOW_UNITS", "CMS");
 * const j1 = builder.addNode("J1", NodeType.JUNCTION);
 * const out1 = builder.addNode("OUT1", NodeType.OUTFALL);
 * const c1 = builder.addLink("C1", LinkType.CONDUIT);
 * builder.setLinkNodes(c1, j1, out1);
 * builder.setLinkLength(c1, 300.0);
 * builder.setLinkRoughness(c1, 0.013);
 * builder.setLinkXsect(c1, XSectShape.CIRCULAR, 0.5);
 *
 * builder.validate();
 * builder.finalize();
 * const solver = builder.toSolver();
 * ```
 *
 * @author   Caleb Buahin <caleb.buahin@gmail.com>
 * @copyright Copyright (c) 2026 Caleb Buahin. All rights reserved.
 * @license  MIT
 */

import { EngineError, raiseForCode } from "./errors.js";
import { Nodes } from "./Nodes.js";
import { Links } from "./Links.js";
import { Subcatchments } from "./Subcatchments.js";
import { Gages } from "./Gages.js";
import { Controls } from "./Controls.js";
import { Forcing } from "./Forcing.js";
import { Solver } from "./Solver.js";
import { type OpenSwmmWasmModule, oadateToDate, dateToOadate } from "./types.js";

// Buffer sizes used when reading variable-length strings from the engine.
const BUF_SMALL  = 256;
const BUF_MEDIUM = 1024;
const BUF_LARGE  = 4096;

// =============================================================================
// UserFlagDef
// =============================================================================

/**
 * One user-flag schema definition returned by {@link ModelBuilder.getUserflagDef}.
 */
export interface UserFlagDef {
  /** Flag name (stored uppercase). */
  readonly name: string;
  /** Flag type: 0=BOOLEAN, 1=INTEGER, 2=REAL, 3=STRING. */
  readonly type: number;
  /** Optional description. */
  readonly description: string;
}

/**
 * A pair of `(absolute, original)` path strings returned by
 * {@link ModelBuilder.filePathGet}.
 */
export interface FilePaths {
  /** Resolved absolute path (may be empty if never resolved). */
  readonly absolute: string;
  /** Original token as authored in the source .inp file. */
  readonly original: string;
}

/**
 * A `(path, args)` pair for one `[PLUGINS]` row returned by
 * {@link ModelBuilder.pluginGet}.
 */
export interface PluginEntry {
  /** Library path, plugin id, or `id:version` string. */
  readonly path: string;
  /** Space-separated argument tokens. */
  readonly args: string;
}

// =============================================================================
// ModelBuilder
// =============================================================================

/**
 * Build a SWMM model programmatically (no `.inp` file required).
 *
 * The engine starts in `BUILDING` state. Use {@link addNode}, {@link addLink},
 * etc. to populate the model, then call {@link finalize} to transition to
 * `INITIALIZED`.
 *
 * @note The `ModelBuilder` owns its engine handle until {@link toSolver} is
 * called; the resulting {@link Solver} then takes ownership.
 */
export class ModelBuilder {
  /** @internal */
  private readonly _mod: OpenSwmmWasmModule;

  /**
   * Opaque engine handle (integer pointer into the WASM heap).
   *
   * After {@link toSolver} is called this is set to `0` and must not be used.
   */
  private _handle: number;

  /**
   * Monotonic counter incremented on every structural mutation (add/pop).
   *
   * Mirrors the `Nodes.generation` mechanism so that {@link Node} wrappers
   * obtained from the builder can detect staleness when the model is mutated.
   */
  private _generation: number = 0;

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  /**
   * Create a new empty model in `BUILDING` state.
   *
   * @param mod  The Emscripten module returned by `createOpenSwmmModule()`.
   * @throws {@link EngineError} if the engine context cannot be allocated.
   */
  constructor(mod: OpenSwmmWasmModule) {
    this._mod = mod;
    const h = mod.swmm_engine_new();
    if (!h) throw new EngineError(7, "swmm_engine_new() returned NULL");
    this._handle = h;
  }

  // -------------------------------------------------------------------------
  // Handle & generation
  // -------------------------------------------------------------------------

  /**
   * Raw engine handle as an integer (WASM heap pointer).
   *
   * Only valid before {@link toSolver} is called.
   */
  get handle(): number {
    this._assertValid();
    return this._handle;
  }

  /**
   * Monotonic counter bumped on every structural mutation (addNode, addLink,
   * addSubcatchment, addGage, popLastNode, popLastLink).
   */
  get generation(): number {
    return this._generation;
  }

  /** @internal */
  private _assertValid(): void {
    if (!this._handle) {
      throw new EngineError(7, "ModelBuilder has been consumed by toSolver()");
    }
  }

  // -------------------------------------------------------------------------
  // Virtual filesystem helpers (delegate to Emscripten FS)
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
  // Node operations
  // -------------------------------------------------------------------------

  /**
   * Add a node to the model.
   *
   * Valid in `BUILDING` or `OPENED` state.
   *
   * @param nodeId    Unique node identifier.
   * @param nodeType  Node type code (see {@link NodeType}).
   * @returns The zero-based index of the newly added node.
   * @throws {@link EngineError} on failure.
   */
  addNode(nodeId: string, nodeType: number): number {
    this._assertValid();
    raiseForCode(this._mod.swmm_node_add(this._handle, nodeId, nodeType));
    this._generation++;
    return this._mod.swmm_node_count(this._handle) - 1;
  }

  /**
   * Remove the most recently added node (undo-of-add).
   *
   * Valid in `BUILDING` or `OPENED` state. The `nodeId` must match the
   * current tail of the node list; pop any referencing links first via
   * {@link popLastLink}.
   *
   * @param nodeId  Expected tail node identifier.
   * @throws {@link EngineError} on failure.
   */
  popLastNode(nodeId: string): void {
    this._assertValid();
    raiseForCode(this._mod.swmm_node_pop_last(this._handle, nodeId));
    this._generation++;
  }

  // -------------------------------------------------------------------------
  // Link operations
  // -------------------------------------------------------------------------

  /**
   * Add a link to the model.
   *
   * Valid in `BUILDING` or `OPENED` state.
   *
   * @param linkId    Unique link identifier.
   * @param linkType  Link type code (see {@link LinkType}).
   * @returns The zero-based index of the newly added link.
   * @throws {@link EngineError} on failure.
   */
  addLink(linkId: string, linkType: number): number {
    this._assertValid();
    raiseForCode(this._mod.swmm_link_add(this._handle, linkId, linkType));
    this._generation++;
    return this._mod.swmm_link_count(this._handle) - 1;
  }

  /**
   * Remove the most recently added link (undo-of-add).
   *
   * @param linkId  Expected tail link identifier.
   * @throws {@link EngineError} on failure.
   */
  popLastLink(linkId: string): void {
    this._assertValid();
    raiseForCode(this._mod.swmm_link_pop_last(this._handle, linkId));
    this._generation++;
  }

  // -------------------------------------------------------------------------
  // Subcatchment and gage operations
  // -------------------------------------------------------------------------

  /**
   * Add a subcatchment to the model.
   *
   * @param scId  Unique subcatchment identifier.
   * @returns The zero-based index of the newly added subcatchment.
   * @throws {@link EngineError} on failure.
   */
  addSubcatchment(scId: string): number {
    this._assertValid();
    raiseForCode(this._mod.swmm_subcatch_add(this._handle, scId));
    this._generation++;
    return this._mod.swmm_subcatch_count(this._handle) - 1;
  }

  /**
   * Add a rain gage to the model.
   *
   * @param gageId  Unique gage identifier.
   * @returns The zero-based index of the newly added gage.
   * @throws {@link EngineError} on failure.
   */
  addGage(gageId: string): number {
    this._assertValid();
    raiseForCode(this._mod.swmm_gage_add(this._handle, gageId));
    this._generation++;
    return this._mod.swmm_gage_count(this._handle) - 1;
  }

  // -------------------------------------------------------------------------
  // Node property setters
  // -------------------------------------------------------------------------

  /**
   * Set the invert elevation of a node.
   *
   * @param idx   Zero-based node index.
   * @param elev  Invert elevation (project length units).
   * @throws {@link EngineError} on failure.
   */
  setNodeInvert(idx: number, elev: number): void {
    this._assertValid();
    raiseForCode(this._mod.swmm_node_set_invert_elev(this._handle, idx, elev));
  }

  /**
   * Set the maximum depth of a node.
   *
   * @param idx    Zero-based node index.
   * @param depth  Maximum depth (project length units).
   * @throws {@link EngineError} on failure.
   */
  setNodeMaxDepth(idx: number, depth: number): void {
    this._assertValid();
    raiseForCode(this._mod.swmm_node_set_max_depth(this._handle, idx, depth));
  }

  // -------------------------------------------------------------------------
  // Link property setters
  // -------------------------------------------------------------------------

  /**
   * Set the upstream and downstream nodes for a link.
   *
   * @param idx       Zero-based link index.
   * @param fromNode  Upstream node index.
   * @param toNode    Downstream node index.
   * @throws {@link EngineError} on failure.
   */
  setLinkNodes(idx: number, fromNode: number, toNode: number): void {
    this._assertValid();
    raiseForCode(this._mod.swmm_link_set_nodes(this._handle, idx, fromNode, toNode));
  }

  /**
   * Set the length of a conduit link.
   *
   * @param idx     Zero-based link index.
   * @param length  Conduit length (project length units).
   * @throws {@link EngineError} on failure.
   */
  setLinkLength(idx: number, length: number): void {
    this._assertValid();
    raiseForCode(this._mod.swmm_link_set_length(this._handle, idx, length));
  }

  /**
   * Set Manning's roughness coefficient for a conduit.
   *
   * @param idx  Zero-based link index.
   * @param n    Manning's _n_ (dimensionless).
   * @throws {@link EngineError} on failure.
   */
  setLinkRoughness(idx: number, n: number): void {
    this._assertValid();
    raiseForCode(this._mod.swmm_link_set_roughness(this._handle, idx, n));
  }

  /**
   * Set the cross-section geometry of a conduit.
   *
   * @param idx    Zero-based link index.
   * @param shape  Cross-section shape code (see {@link XSectShape}).
   * @param geom1  Primary geometry parameter (e.g. diameter for circular).
   * @param geom2  Secondary geometry parameter (default `0`).
   * @param geom3  Tertiary geometry parameter (default `0`).
   * @param geom4  Quaternary geometry parameter (default `0`).
   * @throws {@link EngineError} on failure.
   */
  setLinkXsect(
    idx: number,
    shape: number,
    geom1: number,
    geom2 = 0,
    geom3 = 0,
    geom4 = 0,
  ): void {
    this._assertValid();
    raiseForCode(
      this._mod.swmm_link_set_xsect(this._handle, idx, shape, geom1, geom2, geom3, geom4),
    );
  }

  // -------------------------------------------------------------------------
  // Validation and finalization
  // -------------------------------------------------------------------------

  /**
   * Validate model topology without changing state.
   *
   * Checks for orphaned links and ensures at least one outfall is present.
   * Does not change state. Safe to call multiple times.
   *
   * @throws {@link EngineError} if topology validation fails.
   */
  validate(): void {
    this._assertValid();
    raiseForCode(this._mod.swmm_validate_model(this._handle));
  }

  /**
   * Finalize the model — build connectivity and allocate arrays.
   *
   * Transitions to `INITIALIZED` state.
   *
   * @throws {@link EngineError} if finalization fails.
   */
  finalize(): void {
    this._assertValid();
    raiseForCode(this._mod.swmm_finalize_model(this._handle));
  }

  /**
   * Write the model to a SWMM `.inp` file on the virtual filesystem.
   *
   * @param path  Output file path (virtual FS).
   * @throws {@link EngineError} on failure.
   */
  write(path: string): void {
    this._assertValid();
    raiseForCode(this._mod.swmm_model_write(this._handle, path));
  }

  /**
   * Write the current model to disk using an output plugin.
   *
   * @param path             Destination file path.
   * @param outputPluginId   Plugin id, or `""` for the built-in `.inp` writer.
   * @throws {@link EngineError} on failure.
   */
  writeWithPlugin(path: string, outputPluginId = ""): void {
    this._assertValid();
    raiseForCode(this._mod.swmm_model_write_with_plugin(this._handle, path, outputPluginId));
  }

  // -------------------------------------------------------------------------
  // [TITLE] section
  // -------------------------------------------------------------------------

  /**
   * Number of lines in the `[TITLE]` section.
   *
   * @throws {@link EngineError} on failure.
   */
  getTitleCount(): number {
    this._assertValid();
    const ptr = this._mod._malloc(4);
    try {
      raiseForCode(this._mod.swmm_title_get_count(this._handle, ptr));
      return this._mod.getValue(ptr, "i32");
    } finally {
      this._mod._free(ptr);
    }
  }

  /**
   * Return a title line by zero-based index.
   *
   * @throws {@link EngineError} on bad index or failure.
   */
  getTitleLine(index: number): string {
    this._assertValid();
    return this._mod.swmm_title_get_line(this._handle, index);
  }

  /**
   * Append a new line to the `[TITLE]` section.
   *
   * @throws {@link EngineError} on failure.
   */
  addTitleLine(line: string): void {
    this._assertValid();
    raiseForCode(this._mod.swmm_title_add_line(this._handle, line));
  }

  /**
   * Replace all title lines with new text. Newlines split lines.
   *
   * @throws {@link EngineError} on failure.
   */
  setTitle(text: string): void {
    this._assertValid();
    raiseForCode(this._mod.swmm_title_set(this._handle, text));
  }

  /**
   * Remove all lines from the `[TITLE]` section.
   *
   * @throws {@link EngineError} on failure.
   */
  clearTitle(): void {
    this._assertValid();
    raiseForCode(this._mod.swmm_title_clear(this._handle));
  }

  // -------------------------------------------------------------------------
  // [OPTIONS] / CRS
  // -------------------------------------------------------------------------

  /**
   * Return a SWMM standard option value as a string.
   *
   * @param key  Option name (e.g. `"FLOW_UNITS"`, `"ROUTING_MODEL"`).
   * @throws {@link EngineError} on unknown key or failure.
   */
  getOption(key: string): string {
    this._assertValid();
    const rc = this._mod.swmm_options_get(this._handle, key);
    // The C++ wrapper returns "" on error; rely on error state check
    return rc;
  }

  /**
   * Set a SWMM standard option.
   *
   * @param key    Option name.
   * @param value  New value string.
   * @throws {@link EngineError} on unknown key, invalid value, or failure.
   */
  setOption(key: string, value: string): void {
    this._assertValid();
    raiseForCode(this._mod.swmm_options_set(this._handle, key, value));
  }

  /**
   * Return the value of an extension option (unknown to base SWMM).
   *
   * @throws {@link EngineError} on unknown key.
   */
  getOptionExt(key: string): string {
    this._assertValid();
    return this._mod.swmm_options_get_ext(this._handle, key);
  }

  /**
   * Set the value of an extension option.
   *
   * @throws {@link EngineError} on failure.
   */
  setOptionExt(key: string, value: string): void {
    this._assertValid();
    raiseForCode(this._mod.swmm_options_set_ext(this._handle, key, value));
  }

  /**
   * Return the model's coordinate reference system string.
   *
   * @returns CRS string (EPSG identifier, PROJ string, or WKT), or `""`
   *          if none has been set.
   */
  getCrs(): string {
    this._assertValid();
    return this._mod.swmm_get_crs(this._handle);
  }

  // -------------------------------------------------------------------------
  // Typed date/time options
  // -------------------------------------------------------------------------

  /**
   * Simulation start date/time (settable while in `BUILDING` or `OPENED` state).
   */
  get startDatetime(): Date {
    this._assertValid();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_options_get_start_date(this._handle, ptr));
      return oadateToDate(this._mod.getValue(ptr, "double"));
    } finally {
      this._mod._free(ptr);
    }
  }

  set startDatetime(date: Date) {
    this._assertValid();
    raiseForCode(this._mod.swmm_options_set_start_date(this._handle, dateToOadate(date)));
  }

  /**
   * Simulation end date/time.
   */
  get endDatetime(): Date {
    this._assertValid();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_options_get_end_date(this._handle, ptr));
      return oadateToDate(this._mod.getValue(ptr, "double"));
    } finally {
      this._mod._free(ptr);
    }
  }

  set endDatetime(date: Date) {
    this._assertValid();
    raiseForCode(this._mod.swmm_options_set_end_date(this._handle, dateToOadate(date)));
  }

  /**
   * Report start date/time.
   */
  get reportStartDatetime(): Date {
    this._assertValid();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_options_get_report_start(this._handle, ptr));
      return oadateToDate(this._mod.getValue(ptr, "double"));
    } finally {
      this._mod._free(ptr);
    }
  }

  set reportStartDatetime(date: Date) {
    this._assertValid();
    raiseForCode(this._mod.swmm_options_set_report_start(this._handle, dateToOadate(date)));
  }

  // -------------------------------------------------------------------------
  // User flags (schema-level scalar getters/setters)
  // -------------------------------------------------------------------------

  /**
   * Return a boolean user flag value.
   *
   * @param name  Flag name (as defined in `[USER_FLAGS]`).
   * @throws {@link EngineError} if flag not found or wrong type.
   */
  getUserflagBool(name: string): boolean {
    this._assertValid();
    const ptr = this._mod._malloc(4);
    try {
      raiseForCode(this._mod.swmm_userflag_get_bool(this._handle, name, ptr));
      return this._mod.getValue(ptr, "i32") !== 0;
    } finally {
      this._mod._free(ptr);
    }
  }

  /**
   * Return an integer user flag value.
   *
   * @throws {@link EngineError} if not found or wrong type.
   */
  getUserflagInt(name: string): number {
    this._assertValid();
    const ptr = this._mod._malloc(4);
    try {
      raiseForCode(this._mod.swmm_userflag_get_int(this._handle, name, ptr));
      return this._mod.getValue(ptr, "i32");
    } finally {
      this._mod._free(ptr);
    }
  }

  /**
   * Return a real-valued user flag.
   *
   * @throws {@link EngineError} if not found or wrong type.
   */
  getUserflagReal(name: string): number {
    this._assertValid();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_userflag_get_real(this._handle, name, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /**
   * Set a boolean user flag at runtime.
   *
   * @throws {@link EngineError} on failure.
   */
  setUserflagBool(name: string, value: boolean): void {
    this._assertValid();
    raiseForCode(this._mod.swmm_userflag_set_bool(this._handle, name, value ? 1 : 0));
  }

  /**
   * Set an integer user flag at runtime.
   *
   * @throws {@link EngineError} on failure.
   */
  setUserflagInt(name: string, value: number): void {
    this._assertValid();
    raiseForCode(this._mod.swmm_userflag_set_int(this._handle, name, value));
  }

  /**
   * Set a real-valued user flag at runtime.
   *
   * @throws {@link EngineError} on failure.
   */
  setUserflagReal(name: string, value: number): void {
    this._assertValid();
    raiseForCode(this._mod.swmm_userflag_set_real(this._handle, name, value));
  }

  // -------------------------------------------------------------------------
  // User flag schema definitions
  // -------------------------------------------------------------------------

  /**
   * Return the number of user-flag schema definitions.
   */
  getUserflagDefCount(): number {
    this._assertValid();
    const ptr = this._mod._malloc(4);
    try {
      raiseForCode(this._mod.swmm_userflag_def_count(this._handle, ptr));
      return this._mod.getValue(ptr, "i32");
    } finally {
      this._mod._free(ptr);
    }
  }

  /**
   * Return `{name, type, description}` for the definition at `index`.
   *
   * @throws {@link EngineError} if index is out of range.
   */
  getUserflagDef(index: number): UserFlagDef {
    this._assertValid();
    const nameBuf = this._mod._malloc(BUF_SMALL);
    const typePtr = this._mod._malloc(4);
    const descBuf = this._mod._malloc(BUF_MEDIUM);
    try {
      raiseForCode(
        this._mod.swmm_userflag_def_get(
          this._handle, index,
          nameBuf, BUF_SMALL,
          typePtr,
          descBuf, BUF_MEDIUM,
        ),
      );
      return {
        name:        this._mod.UTF8ToString(nameBuf),
        type:        this._mod.getValue(typePtr, "i32"),
        description: this._mod.UTF8ToString(descBuf),
      };
    } finally {
      this._mod._free(nameBuf);
      this._mod._free(typePtr);
      this._mod._free(descBuf);
    }
  }

  /**
   * Define (or redefine) a user-flag schema entry (`[USER_FLAGS]`).
   *
   * @param name         Flag name (stored uppercase).
   * @param type         0=BOOLEAN, 1=INTEGER, 2=REAL, 3=STRING.
   * @param description  Optional description.
   * @throws {@link EngineError} on empty name, invalid type, or failure.
   */
  defineUserflag(name: string, type: number, description = ""): void {
    this._assertValid();
    raiseForCode(this._mod.swmm_userflag_define(this._handle, name, type, description));
  }

  /**
   * Remove a user-flag definition and all its per-object values.
   *
   * @throws {@link EngineError} if the flag is not defined.
   */
  undefineUserflag(name: string): void {
    this._assertValid();
    raiseForCode(this._mod.swmm_userflag_undefine(this._handle, name));
  }

  // -------------------------------------------------------------------------
  // User flag per-object values
  // -------------------------------------------------------------------------

  /**
   * Return a per-object flag value string, or `undefined` when unassigned.
   *
   * @param objType   Object type token (e.g. `"NODE"`, `"LINK"`).
   * @param objName   Object identifier (case-preserved).
   * @param flagName  Flag name (case-insensitive).
   * @throws {@link EngineError} on failure.
   */
  getUserflagValue(
    objType: string,
    objName: string,
    flagName: string,
  ): string | undefined {
    this._assertValid();
    const buf      = this._mod._malloc(BUF_MEDIUM);
    const foundPtr = this._mod._malloc(4);
    try {
      raiseForCode(
        this._mod.swmm_userflag_value_get(
          this._handle, objType, objName, flagName, buf, BUF_MEDIUM, foundPtr,
        ),
      );
      const found = this._mod.getValue(foundPtr, "i32");
      return found ? this._mod.UTF8ToString(buf) : undefined;
    } finally {
      this._mod._free(buf);
      this._mod._free(foundPtr);
    }
  }

  /**
   * Assign a per-object flag value from a string (typed parse).
   *
   * @throws {@link EngineError} on undefined flag, unparseable value, or failure.
   */
  setUserflagValue(
    objType: string,
    objName: string,
    flagName: string,
    value: string,
  ): void {
    this._assertValid();
    raiseForCode(
      this._mod.swmm_userflag_value_set(this._handle, objType, objName, flagName, value),
    );
  }

  /**
   * Remove a per-object flag value (idempotent).
   *
   * @throws {@link EngineError} on failure.
   */
  clearUserflagValue(objType: string, objName: string, flagName: string): void {
    this._assertValid();
    raiseForCode(
      this._mod.swmm_userflag_value_clear(this._handle, objType, objName, flagName),
    );
  }

  // -------------------------------------------------------------------------
  // [PLUGINS] section
  // -------------------------------------------------------------------------

  /**
   * Return the number of `[PLUGINS]` entries currently registered.
   */
  pluginsCount(): number {
    this._assertValid();
    const ptr = this._mod._malloc(4);
    try {
      raiseForCode(this._mod.swmm_plugins_count(this._handle, ptr));
      return this._mod.getValue(ptr, "i32");
    } finally {
      this._mod._free(ptr);
    }
  }

  /**
   * Read one `[PLUGINS]` row by index.
   *
   * @param idx  Index in `[0, pluginsCount())`.
   * @throws {@link EngineError} if index is out of range.
   */
  pluginGet(idx: number): PluginEntry {
    this._assertValid();
    const pathBuf = this._mod._malloc(BUF_MEDIUM);
    const argsBuf = this._mod._malloc(BUF_MEDIUM);
    try {
      raiseForCode(
        this._mod.swmm_plugin_get(
          this._handle, idx,
          pathBuf, BUF_MEDIUM,
          argsBuf, BUF_MEDIUM,
        ),
      );
      return {
        path: this._mod.UTF8ToString(pathBuf),
        args: this._mod.UTF8ToString(argsBuf),
      };
    } finally {
      this._mod._free(pathBuf);
      this._mod._free(argsBuf);
    }
  }

  /**
   * Add or replace a `[PLUGINS]` row keyed by `pathOrId`.
   *
   * @param pathOrId  Library path, plugin id, or `id:version` string.
   * @param args      Space-separated argument tokens (default `""`).
   * @throws {@link EngineError} on failure.
   */
  pluginSet(pathOrId: string, args = ""): void {
    this._assertValid();
    raiseForCode(this._mod.swmm_plugin_set(this._handle, pathOrId, args));
  }

  /**
   * Remove the `[PLUGINS]` row matching `pathOrId` (idempotent).
   *
   * @throws {@link EngineError} on failure.
   */
  pluginRemove(pathOrId: string): void {
    this._assertValid();
    raiseForCode(this._mod.swmm_plugin_remove(this._handle, pathOrId));
  }

  // -------------------------------------------------------------------------
  // [FILES] section
  // -------------------------------------------------------------------------

  /**
   * Read one `[FILES]` field by key.
   *
   * @param key  Field key (e.g. `"RAINFALL_PATH"`, `"HOTSTART_USE_PATH"`).
   * @throws {@link EngineError} on unknown key or failure.
   */
  filesGet(key: string): string {
    this._assertValid();
    return this._mod.swmm_files_get(this._handle, key);
  }

  /**
   * Write one `[FILES]` field by key.
   *
   * @param key    Field key.
   * @param value  New value; `""` to clear.
   * @throws {@link EngineError} on unknown key or failure.
   */
  filesSet(key: string, value: string): void {
    this._assertValid();
    raiseForCode(this._mod.swmm_files_set(this._handle, key, value));
  }

  // -------------------------------------------------------------------------
  // External file path slots (IO-9)
  // -------------------------------------------------------------------------

  /**
   * Read both `(absolute, original)` strings from an external-file slot.
   *
   * @param role   A {@link FilePathRole} value.
   * @param owner  Owner key for vector slots; `""` for scalar slots.
   * @throws {@link EngineError} on failure.
   */
  filePathGet(role: number, owner = ""): FilePaths {
    this._assertValid();
    const absBuf  = this._mod._malloc(BUF_LARGE);
    const origBuf = this._mod._malloc(BUF_LARGE);
    try {
      raiseForCode(
        this._mod.swmm_file_path_get(
          this._handle, role, owner,
          absBuf, BUF_LARGE,
          origBuf, BUF_LARGE,
        ),
      );
      return {
        absolute: this._mod.UTF8ToString(absBuf),
        original: this._mod.UTF8ToString(origBuf),
      };
    } finally {
      this._mod._free(absBuf);
      this._mod._free(origBuf);
    }
  }

  /**
   * Set the original token for an external-file slot; clears the cached
   * absolute resolution.
   *
   * @param role     A {@link FilePathRole} value.
   * @param newPath  New path token; `""` to clear the slot.
   * @param owner    Owner key for vector slots; `""` for scalar slots.
   * @throws {@link EngineError} on failure.
   */
  filePathSet(role: number, newPath: string, owner = ""): void {
    this._assertValid();
    raiseForCode(this._mod.swmm_file_path_set(this._handle, role, owner, newPath));
  }

  // -------------------------------------------------------------------------
  // Domain collection accessors (read-only views)
  // -------------------------------------------------------------------------

  /**
   * Node collection view.
   *
   * Provides read-only access to nodes that have already been added to the
   * model. Useful for inspecting IDs and indices during building.
   */
  get nodes(): Nodes {
    this._assertValid();
    return new Nodes(this._mod, this._handle);
  }

  /**
   * Link collection view.
   */
  get links(): Links {
    this._assertValid();
    return new Links(this._mod, this._handle);
  }

  /**
   * Subcatchment collection view.
   */
  get subcatchments(): Subcatchments {
    this._assertValid();
    return new Subcatchments(this._mod, this._handle);
  }

  /**
   * Rain gage collection view.
   */
  get gages(): Gages {
    this._assertValid();
    return new Gages(this._mod, this._handle);
  }

  // -------------------------------------------------------------------------
  // Conversion to Solver
  // -------------------------------------------------------------------------

  /**
   * Transfer ownership of the engine handle to a {@link Solver}.
   *
   * After this call the `ModelBuilder` is invalidated and must not be used.
   * The returned `Solver` owns the engine handle and exposes the full
   * simulation API.
   *
   * Typically called after {@link finalize}.
   *
   * @returns A new {@link Solver} wrapping this model's engine.
   * @throws {@link EngineError} if already consumed.
   */
  toSolver(): Solver {
    this._assertValid();
    const solver = new Solver(this._mod, this._handle);
    this._handle = 0; // invalidate this builder
    return solver;
  }

  // -------------------------------------------------------------------------
  // Explicit resource management (TC39 proposal Stage 3)
  // -------------------------------------------------------------------------

  /**
   * Dispose of the engine context if not yet transferred to a `Solver`.
   *
   * Enables use of `using builder = new ModelBuilder(mod)` in TypeScript 5.2+
   * environments.
   */
  [Symbol.dispose](): void {
    if (this._handle) {
      this._mod.swmm_engine_destroy(this._handle);
      this._handle = 0;
    }
  }
}
