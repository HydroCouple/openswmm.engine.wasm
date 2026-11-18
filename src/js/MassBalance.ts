/**
 * @file MassBalance.ts
 * @brief `solver.massBalance`: continuity errors, totals and routing
 *        diagnostics (Python `openswmm.engine._massbalance`).
 *
 * @license  Apache-2.0
 */

import { RoutingTotal, RunoffTotal } from "./enums.js";
import { raiseForCode } from "./errors.js";
import { resolveIndex } from "./element.js";
import { checkedAlloc, withDouble } from "./mem.js";
import type { RoutingDiagnostics } from "./Report.js";
import { SolverView } from "./view.js";

/** `solver.massBalance`. Values reflect the engine's current state. */
export class MassBalance extends SolverView {
  /** @internal */
  private _d(fn: (h: number, out: number) => number): number {
    return withDouble(this._mod, (p) => fn(this._h, p));
  }

  /** @internal */
  private _pollutant(key: number | string): number {
    return resolveIndex(this._raw, this._h, "pollutant", key);
  }

  /** Runoff continuity error as a fraction (0.001 = 0.1 %). */
  get runoffContinuityError(): number {
    return this._d(this._raw.swmm_get_runoff_continuity_error);
  }

  /** Flow routing continuity error as a fraction (0.001 = 0.1 %). */
  get routingContinuityError(): number {
    return this._d(this._raw.swmm_get_routing_continuity_error);
  }

  /** Quality routing continuity error of a pollutant, as a signed fraction. */
  qualityContinuityError(pollutant: number | string): number {
    const p = this._pollutant(pollutant);
    return this._d((h, out) => this._raw.swmm_get_quality_continuity_error(h, p, out));
  }

  /** A runoff total ({@link RunoffTotal}). */
  runoffTotal(component: RunoffTotal): number {
    return this._d((h, out) => this._raw.swmm_get_runoff_total(h, component, out));
  }

  /** A flow routing total ({@link RoutingTotal}). */
  routingTotal(component: RoutingTotal): number {
    return this._d((h, out) => this._raw.swmm_get_routing_total(h, component, out));
  }

  /** Routing time-step statistics. */
  get routingDiagnostics(): RoutingDiagnostics {
    const p = checkedAlloc(this._mod, 56);
    try {
      raiseForCode(
        this._raw.swmm_get_routing_stats(this._h, p, p + 8, p + 16, p + 24, p + 32, p + 40, p + 48),
      );
      const f = this._mod.HEAPF64;
      const nSteps = this._mod.HEAP32[(p + 24) >> 2];
      const pct = f[(p + 32) >> 3];
      return {
        avgTimeStep: f[p >> 3],
        minTimeStep: f[(p + 8) >> 3],
        maxTimeStep: f[(p + 16) >> 3],
        nSteps,
        pctNotConverged: pct,
        nStepsNotConverged: Math.round((nSteps * pct) / 100),
        avgIterations: f[(p + 40) >> 3],
        maxCourant: f[(p + 48) >> 3],
      };
    } finally {
      this._mod._free(p);
    }
  }

  /** Largest Courant number of the run. */
  get maxCourant(): number {
    return this._d(this._raw.swmm_get_max_courant);
  }

  /** Mass of a pollutant lost to seepage. */
  qualitySeepLoss(pollutant: number | string): number {
    const p = this._pollutant(pollutant);
    return this._d((h, out) => this._raw.swmm_get_quality_seep_loss(h, p, out));
  }

  /** Mass of a pollutant lost to evaporation. */
  qualityEvapLoss(pollutant: number | string): number {
    const p = this._pollutant(pollutant);
    return this._d((h, out) => this._raw.swmm_get_quality_evap_loss(h, p, out));
  }
}
