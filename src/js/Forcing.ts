/**
 * @file Forcing.ts
 * @brief Runtime forcing interface for the OpenSWMM WASM bindings.
 *
 * @details Mirrors the Python `_forcing.pyi` binding specification. The
 * `Forcing` class allows users to inject values into the engine at runtime
 * (e.g. override node lateral inflows, gage rainfall, link flows) without
 * modifying the .inp file.
 *
 * Forced values persist until explicitly cleared — either for a specific
 * object via {@link Forcing.clear} or for all objects via
 * {@link Forcing.clearAll}.
 *
 * @author   Caleb Buahin <caleb.buahin@gmail.com>
 * @copyright Copyright (c) 2026 Caleb Buahin. All rights reserved.
 * @license  MIT
 */

import { ForcingMode, ForcingTarget } from "./enums.js";
import { raiseForCode } from "./errors.js";
import type { OpenSwmmWasmModule } from "./types.js";

// Re-export for convenience when consumers import from "./Forcing.js"
export { ForcingMode, ForcingTarget };

// =============================================================================
// Forcing
// =============================================================================

/**
 * Runtime forcing interface.
 *
 * Obtain via {@link Solver.forcing}.
 *
 * @remarks
 * All forcing methods take a `mode` parameter:
 * - {@link ForcingMode.REPLACE} — replace the engine-computed value entirely.
 * - {@link ForcingMode.ADD}     — add the forced value on top of the computed value.
 *
 * @example
 * ```ts
 * const forcing = solver.forcing;
 * const nodeIdx = solver.nodes.getIndex("J1");
 *
 * // Inject 0.5 m³/s lateral inflow at node J1
 * forcing.nodeLatInflow(nodeIdx, 0.5, ForcingMode.REPLACE);
 *
 * // Override rainfall at gage G1 to 10 mm/hr
 * const gageIdx = solver.gages.getIndex("G1");
 * forcing.gageRainfall(gageIdx, 10.0, ForcingMode.REPLACE);
 *
 * // Clear forcing on node J1
 * forcing.clear(ForcingTarget.NODE, nodeIdx);
 *
 * // Clear all forcing
 * forcing.clearAll();
 * ```
 */
export class Forcing {
  /** @internal */
  private readonly _mod: OpenSwmmWasmModule;
  /** @internal */
  private readonly _engine: number;

  /** @internal */
  constructor(mod: OpenSwmmWasmModule, engine: number) {
    this._mod = mod;
    this._engine = engine;
  }

  // -------------------------------------------------------------------------
  // Node forcing
  // -------------------------------------------------------------------------

  /**
   * Override the lateral inflow at a node.
   *
   * @param nodeIdx  Zero-based node index.
   * @param value    Forced inflow value (flow units).
   * @param mode     {@link ForcingMode.REPLACE} or {@link ForcingMode.ADD}.
   */
  nodeLatInflow(
    nodeIdx: number,
    value: number,
    mode: ForcingMode = ForcingMode.REPLACE,
  ): void {
    raiseForCode(
      this._mod.swmm_forcing_node_lat_inflow(this._engine, nodeIdx, value, mode),
    );
  }

  /**
   * Override the head boundary at an outfall node.
   *
   * @param nodeIdx  Zero-based node index.
   * @param value    Forced head (m or ft).
   * @param mode     {@link ForcingMode.REPLACE} or {@link ForcingMode.ADD}.
   */
  nodeHeadBoundary(
    nodeIdx: number,
    value: number,
    mode: ForcingMode = ForcingMode.REPLACE,
  ): void {
    raiseForCode(
      this._mod.swmm_forcing_node_head_boundary(this._engine, nodeIdx, value, mode),
    );
  }

  // -------------------------------------------------------------------------
  // Link forcing
  // -------------------------------------------------------------------------

  /**
   * Override the flow in a link.
   *
   * @param linkIdx  Zero-based link index.
   * @param value    Forced flow (flow units).
   * @param mode     {@link ForcingMode.REPLACE} or {@link ForcingMode.ADD}.
   */
  linkFlow(
    linkIdx: number,
    value: number,
    mode: ForcingMode = ForcingMode.REPLACE,
  ): void {
    raiseForCode(
      this._mod.swmm_forcing_link_flow(this._engine, linkIdx, value, mode),
    );
  }

  /**
   * Override the control setting of a link (pump/orifice/weir/outlet).
   *
   * @param linkIdx  Zero-based link index.
   * @param value    Forced setting (0–1).
   * @param mode     {@link ForcingMode.REPLACE} or {@link ForcingMode.ADD}.
   */
  linkSetting(
    linkIdx: number,
    value: number,
    mode: ForcingMode = ForcingMode.REPLACE,
  ): void {
    raiseForCode(
      this._mod.swmm_forcing_link_setting(this._engine, linkIdx, value, mode),
    );
  }

  // -------------------------------------------------------------------------
  // Subcatchment forcing
  // -------------------------------------------------------------------------

  /**
   * Override the rainfall rate applied to a subcatchment.
   *
   * @param scIdx    Zero-based subcatchment index.
   * @param value    Forced rainfall (in/hr or mm/hr).
   * @param mode     {@link ForcingMode.REPLACE} or {@link ForcingMode.ADD}.
   */
  subcatchRainfall(
    scIdx: number,
    value: number,
    mode: ForcingMode = ForcingMode.REPLACE,
  ): void {
    raiseForCode(
      this._mod.swmm_forcing_subcatch_rainfall(this._engine, scIdx, value, mode),
    );
  }

  // -------------------------------------------------------------------------
  // Gage forcing
  // -------------------------------------------------------------------------

  /**
   * Override the current rainfall reading at a rain gage.
   *
   * @param gageIdx  Zero-based gage index.
   * @param value    Forced rainfall rate (in/hr or mm/hr).
   * @param mode     {@link ForcingMode.REPLACE} or {@link ForcingMode.ADD}.
   */
  gageRainfall(
    gageIdx: number,
    value: number,
    mode: ForcingMode = ForcingMode.REPLACE,
  ): void {
    raiseForCode(
      this._mod.swmm_forcing_gage_rainfall(this._engine, gageIdx, value, mode),
    );
  }

  // -------------------------------------------------------------------------
  // Clear forcing
  // -------------------------------------------------------------------------

  /**
   * Clear the forcing for a specific object.
   *
   * @param type  Object type ({@link ForcingTarget}).
   * @param idx   Zero-based object index.
   */
  clear(type: ForcingTarget, idx: number): void {
    raiseForCode(this._mod.swmm_forcing_clear(this._engine, type, idx));
  }

  /**
   * Clear all active forcing across all object types.
   */
  clearAll(): void {
    raiseForCode(this._mod.swmm_forcing_clear_all(this._engine));
  }
}
