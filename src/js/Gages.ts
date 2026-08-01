/**
 * @file Gages.ts
 * @brief Rain gage collection and individual gage accessor.
 *
 * @details Mirrors the Python `_gages.pyi` binding specification.
 *
 * @author   Caleb Buahin <caleb.buahin@gmail.com>
 * @copyright Copyright (c) 2026 Caleb Buahin. All rights reserved.
 * @license  MIT
 */

import { GageDataSource, GageRainType } from "./enums.js";
import { ElementNotFoundError, StaleObjectError, raiseForCode } from "./errors.js";
import type { OpenSwmmWasmModule } from "./types.js";

// =============================================================================
// Gage
// =============================================================================

/**
 * Accessor for a single SWMM rain gage.
 *
 * Obtain instances via {@link Gages.get} — do not construct directly.
 */
export class Gage {
  /** @internal */
  private readonly _mod: OpenSwmmWasmModule;
  /** @internal */
  private readonly _engine: number;
  /** @internal */
  private readonly _collection: Gages;
  /** @internal */
  private readonly _generation: number;

  /** Zero-based index of this gage in the model's gage list. */
  readonly index: number;

  /** @internal */
  constructor(
    mod: OpenSwmmWasmModule,
    engine: number,
    collection: Gages,
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

  /** String identifier of this gage. */
  get id(): string {
    this._checkStale();
    return this._mod.swmm_gage_id(this._engine, this.index);
  }

  // -------------------------------------------------------------------------
  // Configuration (read)
  // -------------------------------------------------------------------------

  /** Rainfall data format ({@link GageRainType}). */
  get rainType(): GageRainType {
    this._checkStale();
    const ptr = this._mod._malloc(4);
    try {
      raiseForCode(this._mod.swmm_gage_get_rain_type(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "i32") as GageRainType;
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Data source ({@link GageDataSource}). */
  get dataSource(): GageDataSource {
    this._checkStale();
    const ptr = this._mod._malloc(4);
    try {
      raiseForCode(this._mod.swmm_gage_get_data_source(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "i32") as GageDataSource;
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Multiplier applied to all recorded rainfall values. */
  get scaleFactor(): number {
    this._checkStale();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_gage_get_scale_factor(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Set the scale factor. */
  set scaleFactor(value: number) {
    this._checkStale();
    raiseForCode(this._mod.swmm_gage_set_scale_factor(this._engine, this.index, value));
  }

  /** Recording interval (seconds). */
  get rainInterval(): number {
    this._checkStale();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_gage_get_rain_interval(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Snow catch correction factor. */
  get snowFactor(): number {
    this._checkStale();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_gage_get_snow_factor(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  // -------------------------------------------------------------------------
  // Runtime state
  // -------------------------------------------------------------------------

  /** Current rainfall rate at this gage (in/hr or mm/hr). */
  get rainfall(): number {
    this._checkStale();
    const ptr = this._mod._malloc(8);
    try {
      raiseForCode(this._mod.swmm_gage_get_rainfall(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Set the current rainfall rate (used for direct forcing). */
  set rainfall(value: number) {
    this._checkStale();
    raiseForCode(this._mod.swmm_gage_set_rainfall(this._engine, this.index, value));
  }
}

// =============================================================================
// Gages collection
// =============================================================================

/**
 * Iterable collection of all rain gages in the current model.
 *
 * Obtain via {@link Solver.gages}.
 *
 * @example
 * ```ts
 * for (const gage of solver.gages) {
 *   console.log(gage.id, gage.rainfall);
 * }
 * ```
 */
export class Gages implements Iterable<Gage> {
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

  /** Number of rain gages in the model. */
  get length(): number {
    return this._mod.swmm_gage_count(this._engine);
  }

  /**
   * Look up a gage by zero-based index or string ID.
   *
   * @throws {@link ElementNotFoundError} if not found.
   */
  get(indexOrId: number | string): Gage {
    if (typeof indexOrId === "string") {
      const idx = this._mod.swmm_gage_index(this._engine, indexOrId);
      if (idx < 0) throw new ElementNotFoundError(indexOrId);
      return new Gage(this._mod, this._engine, this, this.generation, idx);
    }
    const count = this.length;
    if (indexOrId < 0 || indexOrId >= count) {
      throw new ElementNotFoundError(
        indexOrId,
        `Gage index ${indexOrId} out of range [0, ${count})`,
      );
    }
    return new Gage(this._mod, this._engine, this, this.generation, indexOrId);
  }

  /** Return the zero-based index for a string gage ID, or -1. */
  getIndex(id: string): number {
    return this._mod.swmm_gage_index(this._engine, id);
  }

  /** Return the string ID for a zero-based gage index. */
  getId(idx: number): string {
    const id = this._mod.swmm_gage_id(this._engine, idx);
    if (!id) throw new ElementNotFoundError(idx, `Gage index ${idx} out of range`);
    return id;
  }

  // -------------------------------------------------------------------------
  // Bulk array accessors
  // -------------------------------------------------------------------------

  /** Current rainfall rates of all gages (in/hr or mm/hr). */
  get rainfalls(): Float64Array {
    const n = this.length;
    const result = new Float64Array(n);
    const ptr = this._mod._malloc(8);
    try {
      for (let i = 0; i < n; i++) {
        raiseForCode(this._mod.swmm_gage_get_rainfall(this._engine, i, ptr));
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

  [Symbol.iterator](): Iterator<Gage> {
    let i = 0;
    const length = this.length;
    return {
      next: (): IteratorResult<Gage> => {
        if (i < length) {
          return { value: this.get(i++), done: false };
        }
        return { value: undefined as unknown as Gage, done: true };
      },
    };
  }
}
