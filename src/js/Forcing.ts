/**
 * @file Forcing.ts
 * @brief Runtime forcing interface for the OpenSWMM WASM bindings.
 *
 * @details Mirrors the Python `_forcing.pyi` binding specification. The
 * `Forcing` class allows users to inject values into the engine at runtime
 * (e.g. override node lateral inflows, gage rainfall, link flows) without
 * modifying the .inp file.
 *
 * By default a forced value applies to the current routing step only and is
 * auto-cleared afterwards (`persist = false`). Pass `persist = true` to keep
 * it until explicitly cleared — either for a specific object via
 * {@link Forcing.clear} or for all objects via {@link Forcing.clearAll}.
 *
 * @author   Caleb Buahin <caleb.buahin@gmail.com>
 * @copyright Copyright (c) 2026 Caleb Buahin. All rights reserved.
 * @license  Apache-2.0
 */

import { ForcingMode, ForcingTarget } from "./enums.js";
import { raiseForCode } from "./errors.js";
import type { OpenSwmmWasmModule } from "./types.js";
import type { RawApi } from "./raw.js";
import { guardedRaw } from "./mem.js";

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
  private readonly _raw: RawApi;
  /** @internal */
  private readonly _engine: number;

  /** @internal */
  constructor(mod: OpenSwmmWasmModule, engine: number,
    private readonly _checkOwner: () => void = () => {}) {
    this._mod = mod;
    this._raw = guardedRaw(mod, this._checkOwner);
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
   * @param persist  `true` keeps the forcing until cleared; `false` (default) auto-clears after the step.
   */
  nodeLatInflow(
    nodeIdx: number,
    value: number,
    mode: ForcingMode = ForcingMode.REPLACE,
    persist = false,
  ): void {
    raiseForCode(
      this._raw.swmm_forcing_node_lat_inflow(this._engine, nodeIdx, value, mode, persist ? 1 : 0),
    );
  }

  /**
   * Override the head boundary at an outfall node.
   *
   * @param nodeIdx  Zero-based node index.
   * @param value    Forced head (m or ft).
   * @param mode     {@link ForcingMode.REPLACE} or {@link ForcingMode.ADD}.
   * @param persist  `true` keeps the forcing until cleared; `false` (default) auto-clears after the step.
   */
  nodeHeadBoundary(
    nodeIdx: number,
    value: number,
    mode: ForcingMode = ForcingMode.REPLACE,
    persist = false,
  ): void {
    raiseForCode(
      this._raw.swmm_forcing_node_head_boundary(this._engine, nodeIdx, value, mode, persist ? 1 : 0),
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
   * @param persist  `true` keeps the forcing until cleared; `false` (default) auto-clears after the step.
   */
  linkFlow(
    linkIdx: number,
    value: number,
    mode: ForcingMode = ForcingMode.REPLACE,
    persist = false,
  ): void {
    raiseForCode(
      this._raw.swmm_forcing_link_flow(this._engine, linkIdx, value, mode, persist ? 1 : 0),
    );
  }

  /**
   * Override the control setting of a link (pump/orifice/weir/outlet).
   *
   * @param linkIdx  Zero-based link index.
   * @param value    Forced setting (0–1).
   * @param mode     {@link ForcingMode.REPLACE} or {@link ForcingMode.ADD}.
   * @param persist  `true` keeps the forcing until cleared; `false` (default) auto-clears after the step.
   */
  linkSetting(
    linkIdx: number,
    value: number,
    mode: ForcingMode = ForcingMode.REPLACE,
    persist = false,
  ): void {
    raiseForCode(
      this._raw.swmm_forcing_link_setting(this._engine, linkIdx, value, mode, persist ? 1 : 0),
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
   * @param persist  `true` keeps the forcing until cleared; `false` (default) auto-clears after the step.
   */
  subcatchRainfall(
    scIdx: number,
    value: number,
    mode: ForcingMode = ForcingMode.REPLACE,
    persist = false,
  ): void {
    raiseForCode(
      this._raw.swmm_forcing_subcatch_rainfall(this._engine, scIdx, value, mode, persist ? 1 : 0),
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
   * @param persist  `true` keeps the forcing until cleared; `false` (default) auto-clears after the step.
   */
  gageRainfall(
    gageIdx: number,
    value: number,
    mode: ForcingMode = ForcingMode.REPLACE,
    persist = false,
  ): void {
    raiseForCode(
      this._raw.swmm_forcing_gage_rainfall(this._engine, gageIdx, value, mode, persist ? 1 : 0),
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
    raiseForCode(this._raw.swmm_forcing_clear(this._engine, type, idx));
  }

  /**
   * Clear all active forcing across all object types.
   */
  clearAll(): void {
    raiseForCode(this._raw.swmm_forcing_clear_all(this._engine));
  }
  /** Node temperature: REPLACE in °C; ADD in °C·ft³/s. Requires heat transport. Indices are zero-based; RESET by default. */
  nodeTemperature(index: number, value: number, mode = ForcingMode.REPLACE, persist = false): void {
    raiseForCode(this._raw.swmm_forcing_node_temperature(this._engine, index, value, mode, persist ? 1 : 0));
  }

  /** Node age: REPLACE in hours; ADD in hours·ft³/s. Requires water age. Indices are zero-based; RESET by default. */
  nodeAge(index: number, value: number, mode = ForcingMode.REPLACE, persist = false): void {
    raiseForCode(this._raw.swmm_forcing_node_age(this._engine, index, value, mode, persist ? 1 : 0));
  }

  /** Link seepage override in internal flow units (ft³/s). Indices are zero-based; RESET by default. */
  linkSeepage(index: number, value: number, mode = ForcingMode.REPLACE, persist = false): void {
    raiseForCode(this._raw.swmm_forcing_link_seepage(this._engine, index, value, mode, persist ? 1 : 0));
  }

}
