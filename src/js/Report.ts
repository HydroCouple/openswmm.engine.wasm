/**
 * @file Report.ts
 * @brief Report records (Python `openswmm.engine._report`).
 *
 * @license  Apache-2.0
 */

/** Routing time-step statistics (the report's "Routing Time Step Summary"). */
export interface RoutingDiagnostics {
  avgTimeStep: number;
  minTimeStep: number;
  maxTimeStep: number;
  nSteps: number;
  pctNotConverged: number;
  nStepsNotConverged: number;
  avgIterations: number;
  maxCourant: number;
}
