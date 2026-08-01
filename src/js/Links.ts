/**
 * @file Links.ts
 * @brief Link collection and individual link accessor for the OpenSWMM WASM bindings.
 *
 * @details Mirrors the Python `_links.pyi` binding specification:
 * - {@link Links} is an iterable collection of all links in the model.
 * - {@link Link} is a single-link accessor with typed property getters/setters.
 *
 * @author   Caleb Buahin <caleb.buahin@gmail.com>
 * @copyright Copyright (c) 2026 Caleb Buahin. All rights reserved.
 * @license  MIT
 */

import { LinkType } from "./enums.js";
import { ElementNotFoundError, StaleObjectError, raiseForCode } from "./errors.js";
import type { OpenSwmmWasmModule } from "./types.js";

// =============================================================================
// Link
// =============================================================================

/**
 * Accessor for a single SWMM link (conduit, pump, orifice, weir, or outlet).
 *
 * Obtain instances via {@link Links.get} or by iterating a {@link Links}
 * collection — do not construct directly.
 */
export class Link {
  /** @internal */
  private readonly _mod: OpenSwmmWasmModule;
  /** @internal */
  private readonly _engine: number;
  /** @internal */
  private readonly _collection: Links;
  /** @internal */
  private readonly _generation: number;

  /** Zero-based index of this link in the model's link list. */
  readonly index: number;

  /** @internal */
  constructor(
    mod: OpenSwmmWasmModule,
    engine: number,
    collection: Links,
    generation: number,
    index: number,
  ) {
    this._mod = mod;
    this._engine = engine;
    this._collection = collection;
    this._generation = generation;
    this.index = index;
  }

  /** @internal */
  private _checkStale(): void {
    if (this._generation !== this._collection.generation) {
      throw new StaleObjectError();
    }
  }

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  /** String identifier of this link. */
  get id(): string {
    this._checkStale();
    return this._mod.swmm_link_id(this._engine, this.index);
  }

  /** Link classification. */
  get type(): LinkType {
    this._checkStale();
    const ptr = this._mod._malloc(4);
    try {
      raiseForCode(this._mod.swmm_link_get_type(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "i32") as LinkType;
    } finally {
      this._mod._free(ptr);
    }
  }

  // -------------------------------------------------------------------------
  // Hydraulic state
  // -------------------------------------------------------------------------

  /** Current flow rate through this link (flow units). */
  get flow(): number {
    this._checkStale();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_link_get_flow(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Set the current flow (available in RUNNING state for conduits). */
  set flow(value: number) {
    this._checkStale();
    raiseForCode(this._mod.swmm_link_set_flow(this._engine, this.index, value));
  }

  /** Water depth at the upstream end (m or ft). */
  get depth(): number {
    this._checkStale();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_link_get_depth(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Flow velocity (m/s or ft/s). */
  get velocity(): number {
    this._checkStale();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_link_get_velocity(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /**
   * Current flow as a fraction of full-pipe capacity (0–1, may exceed 1 for
   * surcharged conduits).
   */
  get capacity(): number {
    this._checkStale();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_link_get_capacity(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Stored volume in this link (m³ or ft³). */
  get volume(): number {
    this._checkStale();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_link_get_volume(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  // -------------------------------------------------------------------------
  // Control settings
  // -------------------------------------------------------------------------

  /**
   * Current control setting (opening fraction for orifices/weirs/outlets,
   * on/off for pumps).
   */
  get controlSetting(): number {
    this._checkStale();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_link_get_control_setting(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Set the control setting (0–1 for throttled links). */
  set controlSetting(value: number) {
    this._checkStale();
    raiseForCode(this._mod.swmm_link_set_control_setting(this._engine, this.index, value));
  }

  /** Target control setting (value the real-time controller is converging to). */
  get targetSetting(): number {
    this._checkStale();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_link_get_target_setting(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Set the target control setting. */
  set targetSetting(value: number) {
    this._checkStale();
    raiseForCode(this._mod.swmm_link_set_target_setting(this._engine, this.index, value));
  }

  /** Whether this link is currently closed (1) or open (0). */
  get isClosed(): boolean {
    this._checkStale();
    const ptr = this._mod._malloc(4);
    try {
      raiseForCode(this._mod.swmm_link_get_closed(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "i32") !== 0;
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Close or open this link. */
  set isClosed(value: boolean) {
    this._checkStale();
    raiseForCode(this._mod.swmm_link_set_closed(this._engine, this.index, value ? 1 : 0));
  }

  // -------------------------------------------------------------------------
  // Topology
  // -------------------------------------------------------------------------

  /** Zero-based index of the upstream (from) node. */
  get fromNodeIndex(): number {
    this._checkStale();
    const ptr = this._mod._malloc(4);
    try {
      raiseForCode(this._mod.swmm_link_get_from_node(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "i32");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Zero-based index of the downstream (to) node. */
  get toNodeIndex(): number {
    this._checkStale();
    const ptr = this._mod._malloc(4);
    try {
      raiseForCode(this._mod.swmm_link_get_to_node(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "i32");
    } finally {
      this._mod._free(ptr);
    }
  }
}

// =============================================================================
// Links collection
// =============================================================================

/**
 * Iterable collection of all links in the current model.
 *
 * Obtain via {@link Solver.links}. Supports numeric index and string-ID lookup
 * as well as `for…of` iteration.
 *
 * @example
 * ```ts
 * const links = solver.links;
 * console.log(links.length);
 *
 * const c1 = links.get("C1");
 * console.log(c1.flow, c1.velocity, c1.capacity);
 *
 * // Bulk access — avoids per-call overhead
 * const flows = links.flows;
 * ```
 */
export class Links implements Iterable<Link> {
  /** @internal */
  private readonly _mod: OpenSwmmWasmModule;
  /** @internal */
  private readonly _engine: number;

  /**
   * Generation counter incremented whenever the engine is re-opened.
   * @internal
   */
  generation: number = 0;

  /** @internal */
  constructor(mod: OpenSwmmWasmModule, engine: number) {
    this._mod = mod;
    this._engine = engine;
  }

  // -------------------------------------------------------------------------
  // Collection interface
  // -------------------------------------------------------------------------

  /** Number of links in the model. */
  get length(): number {
    return this._mod.swmm_link_count(this._engine);
  }

  /**
   * Look up a link by zero-based index or string ID.
   *
   * @throws {@link ElementNotFoundError} if not found.
   */
  get(indexOrId: number | string): Link {
    if (typeof indexOrId === "string") {
      const idx = this._mod.swmm_link_index(this._engine, indexOrId);
      if (idx < 0) throw new ElementNotFoundError(indexOrId);
      return new Link(this._mod, this._engine, this, this.generation, idx);
    }
    const count = this.length;
    if (indexOrId < 0 || indexOrId >= count) {
      throw new ElementNotFoundError(indexOrId, `Link index ${indexOrId} out of range [0, ${count})`);
    }
    return new Link(this._mod, this._engine, this, this.generation, indexOrId);
  }

  /** Return the zero-based index for a string link ID, or -1 if not found. */
  getIndex(id: string): number {
    return this._mod.swmm_link_index(this._engine, id);
  }

  /** Return the string ID for a zero-based link index. */
  getId(idx: number): string {
    const id = this._mod.swmm_link_id(this._engine, idx);
    if (!id) throw new ElementNotFoundError(idx, `Link index ${idx} out of range`);
    return id;
  }

  // -------------------------------------------------------------------------
  // Bulk array accessors
  // -------------------------------------------------------------------------

  /** Flow rates of all links (flow units). */
  get flows(): Float64Array {
    const n = this.length;
    const result = new Float64Array(n);
    const ptr = this._mod._malloc(8);
    try {
      for (let i = 0; i < n; i++) {
        raiseForCode(this._mod.swmm_link_get_flow(this._engine, i, ptr));
        result[i] = this._mod.getValue(ptr, "double");
      }
    } finally {
      this._mod._free(ptr);
    }
    return result;
  }

  /** Depths at the upstream end of all links (m or ft). */
  get depths(): Float64Array {
    const n = this.length;
    const result = new Float64Array(n);
    const ptr = this._mod._malloc(8);
    try {
      for (let i = 0; i < n; i++) {
        raiseForCode(this._mod.swmm_link_get_depth(this._engine, i, ptr));
        result[i] = this._mod.getValue(ptr, "double");
      }
    } finally {
      this._mod._free(ptr);
    }
    return result;
  }

  /** Flow velocities of all links (m/s or ft/s). */
  get velocities(): Float64Array {
    const n = this.length;
    const result = new Float64Array(n);
    const ptr = this._mod._malloc(8);
    try {
      for (let i = 0; i < n; i++) {
        raiseForCode(this._mod.swmm_link_get_velocity(this._engine, i, ptr));
        result[i] = this._mod.getValue(ptr, "double");
      }
    } finally {
      this._mod._free(ptr);
    }
    return result;
  }

  /** Capacity fractions of all links (0–1+). */
  get capacities(): Float64Array {
    const n = this.length;
    const result = new Float64Array(n);
    const ptr = this._mod._malloc(8);
    try {
      for (let i = 0; i < n; i++) {
        raiseForCode(this._mod.swmm_link_get_capacity(this._engine, i, ptr));
        result[i] = this._mod.getValue(ptr, "double");
      }
    } finally {
      this._mod._free(ptr);
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Iteration
  // -------------------------------------------------------------------------

  [Symbol.iterator](): Iterator<Link> {
    let i = 0;
    const length = this.length;
    return {
      next: (): IteratorResult<Link> => {
        if (i < length) {
          return { value: this.get(i++), done: false };
        }
        return { value: undefined as unknown as Link, done: true };
      },
    };
  }
}
