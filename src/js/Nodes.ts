/**
 * @file Nodes.ts
 * @brief Node collection and individual node accessor for the OpenSWMM WASM bindings.
 *
 * @details Mirrors the Python `_nodes.pyi` binding specification:
 * - {@link Nodes} is an iterable collection of all nodes in the model.
 * - {@link Node} is a single-node accessor with typed property getters/setters.
 *
 * All values are in the model's native unit system (see {@link FlowUnits}).
 *
 * @author   Caleb Buahin <caleb.buahin@gmail.com>
 * @copyright Copyright (c) 2026 Caleb Buahin. All rights reserved.
 * @license  MIT
 */

import { NodeType } from "./enums.js";
import { ElementNotFoundError, StaleObjectError, raiseForCode } from "./errors.js";
import type { OpenSwmmWasmModule } from "./types.js";

// =============================================================================
// Node statistics snapshot
// =============================================================================

/**
 * Accumulated statistics for a node since the start of the simulation.
 */
export interface NodeStats {
  /** Maximum water depth recorded (m or ft). */
  readonly maxDepth: number;
  /** Maximum overflow rate recorded (flow units). */
  readonly maxOverflow: number;
  /** Total flooded volume (volume units). */
  readonly volFlooded: number;
  /** Total flooding duration (seconds). */
  readonly timeFlooded: number;
}

// =============================================================================
// Node
// =============================================================================

/**
 * Accessor for a single SWMM node.
 *
 * Obtain instances via {@link Nodes.get} or by iterating a {@link Nodes}
 * collection — do not construct directly.
 *
 * @remarks
 * A `Node` is a lightweight view; it stores only the engine handle, the
 * parent collection reference, and the node index. Calls are forwarded
 * directly to the WASM engine, so every property read crosses the WASM
 * boundary.
 *
 * If the model is closed and re-opened the node wrapper becomes stale;
 * accessing any property then throws {@link StaleObjectError}.
 */
export class Node {
  /** @internal */
  private readonly _mod: OpenSwmmWasmModule;
  /** @internal */
  private readonly _engine: number;
  /** @internal */
  private readonly _collection: Nodes;
  /** @internal */
  private readonly _generation: number;

  /** Zero-based index of this node in the model's node list. */
  readonly index: number;

  /** @internal */
  constructor(
    mod: OpenSwmmWasmModule,
    engine: number,
    collection: Nodes,
    generation: number,
    index: number,
  ) {
    this._mod = mod;
    this._engine = engine;
    this._collection = collection;
    this._generation = generation;
    this.index = index;
  }

  /** @internal — throw if the parent collection has been re-created. */
  private _checkStale(): void {
    if (this._generation !== this._collection.generation) {
      throw new StaleObjectError();
    }
  }

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  /** String identifier of this node. */
  get id(): string {
    this._checkStale();
    return this._mod.swmm_node_id(this._engine, this.index);
  }

  /** Node classification. */
  get type(): NodeType {
    this._checkStale();
    const ptr = this._mod._malloc(4);
    try {
      raiseForCode(this._mod.swmm_node_get_type(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "i32") as NodeType;
    } finally {
      this._mod._free(ptr);
    }
  }

  // -------------------------------------------------------------------------
  // State (read-only during simulation)
  // -------------------------------------------------------------------------

  /** Current water depth above the invert elevation (m or ft). */
  get depth(): number {
    this._checkStale();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_node_get_depth(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Set the water depth (available in BUILDING/OPENED state). */
  set depth(value: number) {
    this._checkStale();
    raiseForCode(this._mod.swmm_node_set_depth(this._engine, this.index, value));
  }

  /** Hydraulic head (invert elevation + depth, m or ft). */
  get head(): number {
    this._checkStale();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_node_get_head(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Current stored volume (m³ or ft³). */
  get volume(): number {
    this._checkStale();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_node_get_volume(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Lateral inflow rate (flow units). */
  get lateralInflow(): number {
    this._checkStale();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_node_get_lateral_inflow(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Inject a lateral inflow (flow units). Calls `swmm_node_set_lateral_inflow`. */
  set lateralInflow(value: number) {
    this._checkStale();
    raiseForCode(this._mod.swmm_node_set_lateral_inflow(this._engine, this.index, value));
  }

  /** Total overflow / flooding rate leaving this node (flow units). */
  get overflow(): number {
    this._checkStale();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_node_get_overflow(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Total inflow rate entering this node (flow units). */
  get inflow(): number {
    this._checkStale();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_node_get_inflow(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Evaporation + exfiltration losses from this node (flow units). */
  get losses(): number {
    this._checkStale();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_node_get_losses(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Total outflow rate leaving this node via downstream links (flow units). */
  get outflow(): number {
    this._checkStale();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_node_get_outflow(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  // -------------------------------------------------------------------------
  // Geometry (settable before initialization)
  // -------------------------------------------------------------------------

  /** Invert elevation (m or ft). */
  get invertElev(): number {
    this._checkStale();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_node_get_invert_elev(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Set invert elevation (BUILDING or OPENED state). */
  set invertElev(value: number) {
    this._checkStale();
    raiseForCode(this._mod.swmm_node_set_invert_elev(this._engine, this.index, value));
  }

  /** Maximum design depth (m or ft). */
  get maxDepth(): number {
    this._checkStale();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_node_get_max_depth(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Set maximum design depth (BUILDING or OPENED state). */
  set maxDepth(value: number) {
    this._checkStale();
    raiseForCode(this._mod.swmm_node_set_max_depth(this._engine, this.index, value));
  }

  // -------------------------------------------------------------------------
  // Boundary conditions
  // -------------------------------------------------------------------------

  /**
   * Impose a fixed head boundary at this node (outfall nodes only).
   * Only valid in RUNNING state; use {@link Forcing.nodeHeadBoundary} for
   * per-step overrides.
   */
  setHeadBoundary(head: number): void {
    this._checkStale();
    raiseForCode(this._mod.swmm_node_set_head_boundary(this._engine, this.index, head));
  }

  // -------------------------------------------------------------------------
  // Statistics
  // -------------------------------------------------------------------------

  /**
   * Accumulated simulation statistics for this node.
   * Only meaningful after the simulation has ended.
   */
  get stats(): NodeStats {
    this._checkStale();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_node_get_stat_max_depth(this._engine, this.index, ptr));
      const maxDepth = this._mod.getValue(ptr, "double");
      raiseForCode(this._mod.swmm_node_get_stat_max_overflow(this._engine, this.index, ptr));
      const maxOverflow = this._mod.getValue(ptr, "double");
      raiseForCode(this._mod.swmm_node_get_stat_vol_flooded(this._engine, this.index, ptr));
      const volFlooded = this._mod.getValue(ptr, "double");
      raiseForCode(this._mod.swmm_node_get_stat_time_flooded(this._engine, this.index, ptr));
      const timeFlooded = this._mod.getValue(ptr, "double");
      return { maxDepth, maxOverflow, volFlooded, timeFlooded };
    } finally {
      this._mod._free(ptr);
    }
  }
}

// =============================================================================
// Nodes collection
// =============================================================================

/**
 * Iterable collection of all nodes in the current model.
 *
 * Obtain via {@link Solver.nodes}. Supports numeric index lookup,
 * string-ID lookup, and `for…of` iteration.
 *
 * @example
 * ```ts
 * const nodes = solver.nodes;
 * console.log(nodes.length);             // number of nodes
 *
 * const n0 = nodes.get(0);              // by numeric index
 * const n1 = nodes.get("J1");           // by string ID
 *
 * for (const node of nodes) {
 *   console.log(node.id, node.depth);
 * }
 * ```
 */
export class Nodes implements Iterable<Node> {
  /** @internal */
  private readonly _mod: OpenSwmmWasmModule;
  /** @internal */
  private readonly _engine: number;

  /**
   * Generation counter incremented whenever the engine is re-opened.
   * Used by {@link Node} to detect stale wrappers.
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

  /** Number of nodes in the model. */
  get length(): number {
    return this._mod.swmm_node_count(this._engine);
  }

  /**
   * Look up a node by zero-based index or string ID.
   *
   * @throws {@link BadIndexError} if `index` is out of range.
   * @throws {@link ElementNotFoundError} if `id` is not found.
   */
  get(indexOrId: number | string): Node {
    if (typeof indexOrId === "string") {
      const idx = this._mod.swmm_node_index(this._engine, indexOrId);
      if (idx < 0) throw new ElementNotFoundError(indexOrId);
      return new Node(this._mod, this._engine, this, this.generation, idx);
    }
    const count = this.length;
    if (indexOrId < 0 || indexOrId >= count) {
      throw new ElementNotFoundError(indexOrId, `Node index ${indexOrId} out of range [0, ${count})`);
    }
    return new Node(this._mod, this._engine, this, this.generation, indexOrId);
  }

  /**
   * Return the zero-based index for a string node ID, or -1 if not found.
   */
  getIndex(id: string): number {
    return this._mod.swmm_node_index(this._engine, id);
  }

  /**
   * Return the string ID for a zero-based node index.
   *
   * @throws {@link BadIndexError} if `idx` is out of range.
   */
  getId(idx: number): string {
    const id = this._mod.swmm_node_id(this._engine, idx);
    if (!id) throw new ElementNotFoundError(idx, `Node index ${idx} out of range`);
    return id;
  }

  // -------------------------------------------------------------------------
  // Bulk array accessors
  // -------------------------------------------------------------------------

  /**
   * Depths of all nodes as a `Float64Array` (m or ft).
   * Avoids the overhead of calling `get(i).depth` in a loop.
   */
  get depths(): Float64Array {
    const n = this.length;
    const result = new Float64Array(n);
    const ptr = this._mod._malloc(8);
    try {
      for (let i = 0; i < n; i++) {
        raiseForCode(this._mod.swmm_node_get_depth(this._engine, i, ptr));
        result[i] = this._mod.getValue(ptr, "double");
      }
    } finally {
      this._mod._free(ptr);
    }
    return result;
  }

  /**
   * Hydraulic heads of all nodes as a `Float64Array` (m or ft).
   */
  get heads(): Float64Array {
    const n = this.length;
    const result = new Float64Array(n);
    const ptr = this._mod._malloc(8);
    try {
      for (let i = 0; i < n; i++) {
        raiseForCode(this._mod.swmm_node_get_head(this._engine, i, ptr));
        result[i] = this._mod.getValue(ptr, "double");
      }
    } finally {
      this._mod._free(ptr);
    }
    return result;
  }

  /**
   * Stored volumes of all nodes as a `Float64Array` (m³ or ft³).
   */
  get volumes(): Float64Array {
    const n = this.length;
    const result = new Float64Array(n);
    const ptr = this._mod._malloc(8);
    try {
      for (let i = 0; i < n; i++) {
        raiseForCode(this._mod.swmm_node_get_volume(this._engine, i, ptr));
        result[i] = this._mod.getValue(ptr, "double");
      }
    } finally {
      this._mod._free(ptr);
    }
    return result;
  }

  /**
   * Lateral inflow rates of all nodes as a `Float64Array` (flow units).
   */
  get lateralInflows(): Float64Array {
    const n = this.length;
    const result = new Float64Array(n);
    const ptr = this._mod._malloc(8);
    try {
      for (let i = 0; i < n; i++) {
        raiseForCode(this._mod.swmm_node_get_lateral_inflow(this._engine, i, ptr));
        result[i] = this._mod.getValue(ptr, "double");
      }
    } finally {
      this._mod._free(ptr);
    }
    return result;
  }

  /**
   * Overflow rates of all nodes as a `Float64Array` (flow units).
   */
  get overflows(): Float64Array {
    const n = this.length;
    const result = new Float64Array(n);
    const ptr = this._mod._malloc(8);
    try {
      for (let i = 0; i < n; i++) {
        raiseForCode(this._mod.swmm_node_get_overflow(this._engine, i, ptr));
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

  /** Iterate over every node in the model in index order. */
  [Symbol.iterator](): Iterator<Node> {
    let i = 0;
    const length = this.length;
    return {
      next: (): IteratorResult<Node> => {
        if (i < length) {
          return { value: this.get(i++), done: false };
        }
        return { value: undefined as unknown as Node, done: true };
      },
    };
  }
}
