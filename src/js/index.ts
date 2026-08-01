/**
 * @file index.ts
 * @brief Public API entry point for `@hydrocouple/openswmm-engine-wasm`.
 *
 * @details Re-exports every public symbol from the package so consumers can
 * import everything from a single specifier:
 *
 * ```ts
 * import {
 *   Solver,
 *   Nodes, Node, Links, Link,
 *   Subcatchments, Subcatchment,
 *   Gages, Gage,
 *   Controls, Forcing,
 *   EngineState, NodeType, FlowUnits,
 *   EngineError, BadIndexError,
 * } from "@hydrocouple/openswmm-engine-wasm";
 * ```
 *
 * The Emscripten-generated WASM loader (`createOpenSwmmModule`) is **not**
 * re-exported here because it lives in the compiled `dist/` directory and
 * is imported separately by the consumer:
 *
 * ```ts
 * import createOpenSwmmModule from
 *   "@hydrocouple/openswmm-engine-wasm/dist/openswmm_engine.js";
 * ```
 *
 * @author   Caleb Buahin <caleb.buahin@gmail.com>
 * @copyright Copyright (c) 2026 Caleb Buahin. All rights reserved.
 * @license  MIT
 */

// ---------------------------------------------------------------------------
// Solver (main lifecycle controller)
// ---------------------------------------------------------------------------
export { Solver } from "./Solver.js";

// ---------------------------------------------------------------------------
// Domain collections and element accessors
// ---------------------------------------------------------------------------
export { Nodes, Node } from "./Nodes.js";
export type { NodeStats } from "./Nodes.js";

export { Links, Link } from "./Links.js";

export { Subcatchments, Subcatchment } from "./Subcatchments.js";

export { Gages, Gage } from "./Gages.js";

export { Controls } from "./Controls.js";
export type { ControlRule } from "./Controls.js";

export { Forcing } from "./Forcing.js";

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------
export {
  ErrorCode,
  EngineState,
  WarnCode,
  ObjectType,
  FlowUnits,
  RouteModel,
  NodeType,
  LinkType,
  OrificeType,
  WeirType,
  OutletRatingType,
  OutfallType,
  StorageShape,
  XSectShape,
  InfilModel,
  GageDataSource,
  GageRainType,
  ConcentrationUnits,
  BuildupFunc,
  WashoffFunc,
  LidType,
  DividerType,
  OutSubcatchVar,
  OutNodeVar,
  OutLinkVar,
  ForcingMode,
  ForcingTarget,
  PatternType,
  RunoffTotal,
  RoutingTotal,
  FilePathRole,
  UserFlagType,
} from "./enums.js";

// ---------------------------------------------------------------------------
// Error hierarchy
// ---------------------------------------------------------------------------
export {
  EngineError,
  BadHandleError,
  BadIndexError,
  BadParamError,
  LifecycleError,
  HotStartError,
  PluginError,
  FileError,
  ParseError,
  NumericalError,
  CRSError,
  DependencyError,
  ElementNotFoundError,
  StaleObjectError,
  raiseForCode,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Utility types and helpers
// ---------------------------------------------------------------------------
export type { OpenSwmmWasmModule, EmscriptenFS } from "./types.js";
export { oadateToDate, dateToOadate } from "./types.js";
