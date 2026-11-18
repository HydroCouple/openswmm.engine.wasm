/**
 * @file view.ts
 * @brief Base of the solver-level service views (pollutants, land uses,
 *        climate, inflows, ...).
 *
 * A view reaches the engine through its solver. With `fresh: true` (item
 * views, as Python's `_check_fresh`) it refuses to work after the solver's
 * generation changed; collection views follow the live model.
 *
 * @license  Apache-2.0
 */

import { StaleObjectError } from "./errors.js";
import { guardedRaw } from "./mem.js";
import type { RawApi } from "./raw.js";
import type { Solver } from "./Solver.js";
import type { OpenSwmmWasmModule } from "./types.js";

export class SolverView {
  /** @internal */
  protected readonly _raw: RawApi;
  /** @internal */
  private readonly _generation: number;

  /** @internal */
  constructor(
    protected readonly _solver: Solver,
    private readonly _fresh = false,
  ) {
    this._raw = guardedRaw(_solver.module, () => void _solver.handle);
    this._generation = _solver.generation;
  }

  /** @internal The engine handle (after the staleness check for item views). */
  protected get _h(): number {
    if (this._fresh && this._generation !== this._solver.generation) {
      throw new StaleObjectError();
    }
    return this._solver.handle;
  }

  /** @internal */
  protected get _mod(): OpenSwmmWasmModule {
    return this._solver.module;
  }

  /** The solver this view belongs to. */
  get solver(): Solver {
    return this._solver;
  }
}
