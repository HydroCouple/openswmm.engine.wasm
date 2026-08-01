/**
 * @file Subcatchments.ts
 * @brief Subcatchment collection and individual subcatchment accessor.
 *
 * @details Mirrors the Python `_subcatchments.pyi` binding specification.
 *
 * @author   Caleb Buahin <caleb.buahin@gmail.com>
 * @copyright Copyright (c) 2026 Caleb Buahin. All rights reserved.
 * @license  MIT
 */

import { ElementNotFoundError, StaleObjectError, raiseForCode } from "./errors.js";
import type { OpenSwmmWasmModule } from "./types.js";

// =============================================================================
// Subcatchment
// =============================================================================

/**
 * Accessor for a single SWMM subcatchment.
 *
 * Obtain instances via {@link Subcatchments.get} — do not construct directly.
 */
export class Subcatchment {
  /** @internal */
  private readonly _mod: OpenSwmmWasmModule;
  /** @internal */
  private readonly _engine: number;
  /** @internal */
  private readonly _collection: Subcatchments;
  /** @internal */
  private readonly _generation: number;

  /** Zero-based index of this subcatchment in the model's subcatchment list. */
  readonly index: number;

  /** @internal */
  constructor(
    mod: OpenSwmmWasmModule,
    engine: number,
    collection: Subcatchments,
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

  /** String identifier of this subcatchment. */
  get id(): string {
    this._checkStale();
    return this._mod.swmm_subcatch_id(this._engine, this.index);
  }

  // -------------------------------------------------------------------------
  // Hydrologic state
  // -------------------------------------------------------------------------

  /** Current surface runoff rate (flow units). */
  get runoff(): number {
    this._checkStale();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_subcatch_get_runoff(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  // -------------------------------------------------------------------------
  // Physical properties
  // -------------------------------------------------------------------------

  /** Subcatchment drainage area (ha or acres). */
  get area(): number {
    this._checkStale();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_subcatch_get_area(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Percent impervious (0–100). */
  get impervPct(): number {
    this._checkStale();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_subcatch_get_imperv_pct(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Representative width used for overland flow routing (m or ft). */
  get width(): number {
    this._checkStale();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_subcatch_get_width(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Land surface slope (%). */
  get slope(): number {
    this._checkStale();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_subcatch_get_slope(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  // -------------------------------------------------------------------------
  // Topology
  // -------------------------------------------------------------------------

  /** Zero-based index of the outlet node, or -1 if draining to another subcatchment. */
  get outletNodeIndex(): number {
    this._checkStale();
    const ptr = this._mod._malloc(4);
    try {
      raiseForCode(this._mod.swmm_subcatch_get_outlet(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "i32");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Zero-based index of the assigned rain gage. */
  get gageIndex(): number {
    this._checkStale();
    const ptr = this._mod._malloc(4);
    try {
      raiseForCode(this._mod.swmm_subcatch_get_gage(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "i32");
    } finally {
      this._mod._free(ptr);
    }
  }
}

// =============================================================================
// Subcatchments collection
// =============================================================================

/**
 * Iterable collection of all subcatchments in the current model.
 *
 * Obtain via {@link Solver.subcatchments}.
 *
 * @example
 * ```ts
 * for (const sc of solver.subcatchments) {
 *   console.log(sc.id, sc.runoff);
 * }
 * ```
 */
export class Subcatchments implements Iterable<Subcatchment> {
  /** @internal */
  private readonly _mod: OpenSwmmWasmModule;
  /** @internal */
  private readonly _engine: number;

  /** @internal */
  generation: number = 0;

  /** @internal */
  constructor(mod: OpenSwmmWasmModule, engine: number) {
    this._mod = mod;
    this._engine = engine;
  }

  // -------------------------------------------------------------------------
  // Collection interface
  // -------------------------------------------------------------------------

  /** Number of subcatchments in the model. */
  get length(): number {
    return this._mod.swmm_subcatch_count(this._engine);
  }

  /**
   * Look up a subcatchment by zero-based index or string ID.
   *
   * @throws {@link ElementNotFoundError} if not found.
   */
  get(indexOrId: number | string): Subcatchment {
    if (typeof indexOrId === "string") {
      const idx = this._mod.swmm_subcatch_index(this._engine, indexOrId);
      if (idx < 0) throw new ElementNotFoundError(indexOrId);
      return new Subcatchment(this._mod, this._engine, this, this.generation, idx);
    }
    const count = this.length;
    if (indexOrId < 0 || indexOrId >= count) {
      throw new ElementNotFoundError(
        indexOrId,
        `Subcatchment index ${indexOrId} out of range [0, ${count})`,
      );
    }
    return new Subcatchment(this._mod, this._engine, this, this.generation, indexOrId);
  }

  /** Return the zero-based index for a string subcatchment ID, or -1. */
  getIndex(id: string): number {
    return this._mod.swmm_subcatch_index(this._engine, id);
  }

  /** Return the string ID for a zero-based subcatchment index. */
  getId(idx: number): string {
    const id = this._mod.swmm_subcatch_id(this._engine, idx);
    if (!id) throw new ElementNotFoundError(idx, `Subcatchment index ${idx} out of range`);
    return id;
  }

  // -------------------------------------------------------------------------
  // Bulk array accessors
  // -------------------------------------------------------------------------

  /** Runoff rates of all subcatchments (flow units). */
  get runoffs(): Float64Array {
    const n = this.length;
    const result = new Float64Array(n);
    const ptr = this._mod._malloc(8);
    try {
      for (let i = 0; i < n; i++) {
        raiseForCode(this._mod.swmm_subcatch_get_runoff(this._engine, i, ptr));
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

  [Symbol.iterator](): Iterator<Subcatchment> {
    let i = 0;
    const length = this.length;
    return {
      next: (): IteratorResult<Subcatchment> => {
        if (i < length) {
          return { value: this.get(i++), done: false };
        }
        return { value: undefined as unknown as Subcatchment, done: true };
      },
    };
  }
}
