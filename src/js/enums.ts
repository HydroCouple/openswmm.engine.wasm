/**
 * @file enums.ts
 * @brief TypeScript enumerations for the OpenSWMM Engine WebAssembly bindings.
 *
 * @details Integer-backed enums that mirror the Python `_enums.py` module and
 * the underlying C API enum definitions in `openswmm_engine.h`. Values are
 * identical to the C constants so they can be passed directly to the
 * Emscripten-compiled engine module.
 *
 * @example
 * ```ts
 * import { EngineState, NodeType } from "@hydrocouple/openswmm-engine-wasm";
 *
 * if (solver.state === EngineState.RUNNING) {
 *   const depth = solver.nodes.get(0).depth;
 * }
 * ```
 *
 * @author   Caleb Buahin <caleb.buahin@gmail.com>
 * @copyright Copyright (c) 2026 Caleb Buahin. All rights reserved.
 * @license  MIT
 */

// =============================================================================
// Lifecycle / errors / object types
// =============================================================================

/**
 * SWMM C API return codes.
 *
 * Mirrors the integer error codes returned by every C API entry point.
 * A non-zero value indicates a failure that the binding layer translates
 * into an {@link EngineError}.
 */
export enum ErrorCode {
  /** Success. */
  OK = 0,
  /** Out of memory. */
  NOMEM = 1,
  /** Cannot open input file. */
  INPFILE = 2,
  /** Cannot open report file. */
  RPTFILE = 3,
  /** Cannot open output file. */
  OUTFILE = 4,
  /** Input file parse error. */
  PARSE = 5,
  /** Function called in wrong lifecycle state. */
  LIFECYCLE = 6,
  /** NULL or invalid engine handle. */
  BADHANDLE = 7,
  /** Object index out of range. */
  BADINDEX = 8,
  /** Invalid parameter value. */
  BADPARAM = 9,
  /** Plugin error. */
  PLUGIN = 10,
  /** I/O error. */
  IO = 11,
  /** Hot start file error. */
  HOTSTART = 12,
  /** Coordinate reference system error. */
  CRS = 13,
  /** Numerical error (e.g. divergence). */
  NUMERICAL = 14,
  /** Object has dependents that block the requested operation. */
  DEPENDENCY = 15,
  /** Internal / unspecified error. */
  INTERNAL = 99,
}

/**
 * Engine lifecycle states.
 *
 * Returned by the `state` property of {@link Solver}. Values mirror
 * `SWMM_EngineState` in `openswmm_engine.h`.
 */
export enum EngineState {
  /** Uninitialised / fatal-error sentinel. */
  NONE = 0,
  /** Context allocated, no input loaded. */
  CREATED = 1,
  /** Input file parsed, objects allocated. */
  OPENED = 2,
  /** Initial conditions applied. */
  INITIALIZED = 3,
  /** Simulation prepared to step (post-start, pre-first-step). */
  STARTED = 4,
  /** Simulation loop in progress. */
  RUNNING = 5,
  /** Simulation loop completed. */
  ENDED = 6,
  /** Resources released. */
  CLOSED = 7,
  /** Programmatic model construction in progress (no .inp). */
  BUILDING = 8,
}

/**
 * Engine warning codes emitted via the warning callback.
 */
export enum WarnCode {
  /** No warning. */
  NONE = 0,
  /** Object missing during hot start application. */
  HOTSTART_MISSING = 1,
  /** Unrecognised input section encountered. */
  UNKNOWN_SECTION = 2,
  /** Unrecognised option keyword. */
  UNKNOWN_OPTION = 3,
  /** Deprecated keyword used. */
  DEPRECATED_KW = 4,
  /** Plugin initialisation issue. */
  PLUGIN_INIT = 5,
  /** Numerical instability handled gracefully. */
  NUMERICAL = 6,
  /** Timestep limited by stability criterion. */
  STABILITY_LIMIT = 7,
}

/**
 * SWMM object type codes used wherever the C API accepts a generic
 * object-type discriminator.
 */
export enum ObjectType {
  /** Rain gage. */
  GAGE = 0,
  /** Subcatchment. */
  SUBCATCH = 1,
  /** Node (junction, outfall, storage, divider). */
  NODE = 2,
  /** Link (conduit, pump, orifice, weir, outlet). */
  LINK = 3,
  /** Pollutant. */
  POLLUT = 4,
  /** Land use category. */
  LANDUSE = 5,
  /** Time series. */
  TIMESER = 6,
  /** Curve / table. */
  TABLE = 7,
  /** RDII unit hydrograph group. */
  RDII = 8,
  /** Unit hydrograph. */
  UNITHYD = 9,
  /** Snowmelt parameter set. */
  SNOWMELT = 10,
  /** Custom cross-section shape. */
  SHAPE = 11,
  /** LID control. */
  LID = 12,
}

// =============================================================================
// Hydraulics
// =============================================================================

/**
 * Flow unit systems.
 *
 * Determines the unit system used throughout the simulation. The first three
 * are US customary; the last three are SI.
 */
export enum FlowUnits {
  /** Cubic feet per second (US customary). */
  CFS = 0,
  /** Gallons per minute (US customary). */
  GPM = 1,
  /** Million gallons per day (US customary). */
  MGD = 2,
  /** Cubic meters per second (SI). */
  CMS = 3,
  /** Liters per second (SI). */
  LPS = 4,
  /** Million liters per day (SI). */
  MLD = 5,
}

/**
 * Hydraulic routing models.
 */
export enum RouteModel {
  /** Steady-state routing. */
  STEADY = 0,
  /** Kinematic wave routing. */
  KINWAVE = 1,
  /** Dynamic wave (full Saint-Venant) routing. */
  DYNWAVE = 2,
}

/**
 * SWMM node type codes.
 */
export enum NodeType {
  /** Manhole / generic junction (most common). */
  JUNCTION = 0,
  /** Drainage system terminus (boundary condition). */
  OUTFALL = 1,
  /** Storage unit with stage-area relationship. */
  STORAGE = 2,
  /** Flow divider (steady-flow routing only). */
  DIVIDER = 3,
}

/**
 * SWMM link type codes.
 */
export enum LinkType {
  /** Conduit (pipe or channel). */
  CONDUIT = 0,
  /** Pump. */
  PUMP = 1,
  /** Orifice. */
  ORIFICE = 2,
  /** Weir. */
  WEIR = 3,
  /** Outlet. */
  OUTLET = 4,
}

/**
 * Orifice flow-attack classification.
 */
export enum OrificeType {
  /** Orifice opens on the side of the upstream node. */
  SIDE = 0,
  /** Orifice opens through the bottom of the upstream node. */
  BOTTOM = 1,
}

/**
 * Weir flow classification.
 */
export enum WeirType {
  /** Sharp-crested transverse weir. */
  TRANSVERSE = 0,
  /** Side-flow weir (USBR formula). */
  SIDEFLOW = 1,
  /** Triangular / V-notch weir. */
  VNOTCH = 2,
  /** Trapezoidal weir. */
  TRAPEZOIDAL = 3,
  /** FHWA HDS-5 roadway weir. */
  ROADWAY = 4,
}

/**
 * Outlet rating-curve classification.
 */
export enum OutletRatingType {
  /** `Q = Cd · H^expon` (head above invert). */
  FUNCTIONAL_HEAD = 0,
  /** `Q = Cd · y^expon` (depth at upstream node). */
  FUNCTIONAL_DEPTH = 1,
  /** `Q` from rating curve indexed by head. */
  TABULAR_HEAD = 2,
  /** `Q` from rating curve indexed by depth. */
  TABULAR_DEPTH = 3,
}

/**
 * Outfall boundary condition type.
 */
export enum OutfallType {
  /** Free outfall (critical or normal depth, whichever is lower). */
  FREE = 0,
  /** Normal depth outfall. */
  NORMAL = 1,
  /** Fixed head outfall. */
  FIXED = 2,
  /** Tidal stage outfall (sinusoidal forcing). */
  TIDAL = 3,
  /** Time-series stage outfall. */
  TIMESERIES = 4,
}

/**
 * Storage-unit surface-area relation codes.
 */
export enum StorageShape {
  /** Area vs. depth from a curve. */
  TABULAR = 0,
  /** `Area = c + a*d^b`. */
  FUNCTIONAL = 1,
  /** Elliptical cylinder: p1 = major axis, p2 = minor axis. */
  CYLINDRICAL = 2,
  /** Elliptical cone: p1, p2 = base axes, p3 = side slope. */
  CONICAL = 3,
  /** Elliptical paraboloid: p1, p2 = top axes, p3 = height. */
  PARABOLOID = 4,
  /** Rectangular pyramid: p1 = length, p2 = width, p3 = side slope. */
  PYRAMIDAL = 5,
}

/**
 * Cross-section shape codes.
 *
 * @remarks **Renumbered in v6.0.** Always pass the enum member rather than a
 * bare integer to avoid assigning the wrong cross-section silently.
 */
export enum XSectShape {
  CIRCULAR = 0,
  FILLED_CIRCULAR = 1,
  RECT_CLOSED = 2,
  RECT_OPEN = 3,
  TRAPEZOIDAL = 4,
  TRIANGULAR = 5,
  PARABOLIC = 6,
  POWER = 7,
  MODBASKETHANDLE = 8,
  EGGSHAPED = 9,
  HORSESHOE = 10,
  GOTHIC = 11,
  CATENARY = 12,
  SEMIELLIPTICAL = 13,
  BASKETHANDLE = 14,
  SEMICIRCULAR = 15,
  RECT_TRIANG = 16,
  RECT_ROUND = 17,
  HORIZ_ELLIPSE = 18,
  VERT_ELLIPSE = 19,
  ARCH = 20,
  IRREGULAR = 21,
  CUSTOM = 22,
  FORCE_MAIN = 23,
  STREET_XSECT = 24,
  DUMMY = 25,
}

// =============================================================================
// Hydrology
// =============================================================================

/**
 * Infiltration model type.
 */
export enum InfilModel {
  /** Original Horton model. */
  HORTON = 0,
  /** Modified Horton model. */
  MOD_HORTON = 1,
  /** Green-Ampt model. */
  GREEN_AMPT = 2,
  /** Modified Green-Ampt model. */
  MOD_GREEN_AMPT = 3,
  /** SCS Curve Number model. */
  CURVE_NUMBER = 4,
}

/**
 * Rain gage data source type.
 */
export enum GageDataSource {
  /** Data comes from a time series object. */
  TIMESERIES = 0,
  /** Data comes from an external rainfall file. */
  FILE = 1,
}

/**
 * Rain gage rainfall data format.
 */
export enum GageRainType {
  /** Rainfall intensity (depth/time). */
  INTENSITY = 0,
  /** Rainfall volume (depth per interval). */
  VOLUME = 1,
  /** Cumulative rainfall depth. */
  CUMULATIVE = 2,
}

// =============================================================================
// Water quality and LID
// =============================================================================

/**
 * Pollutant concentration units.
 */
export enum ConcentrationUnits {
  MG_PER_L = 0,
  UG_PER_L = 1,
  COUNT_PER_L = 2,
}

/**
 * Pollutant buildup function type.
 */
export enum BuildupFunc {
  NONE = 0,
  POW = 1,
  EXP = 2,
  SAT = 3,
  EXT = 4,
}

/**
 * Pollutant washoff function type.
 */
export enum WashoffFunc {
  NONE = 0,
  EXP = 1,
  RC = 2,
  EMC = 3,
}

/**
 * LID (Low Impact Development) control type.
 */
export enum LidType {
  BIO_CELL = 0,
  RAIN_GARDEN = 1,
  GREEN_ROOF = 2,
  INFIL_TRENCH = 3,
  PERM_PAVEMENT = 4,
  RAIN_BARREL = 5,
  ROOFTOP_DISCONN = 6,
  VEGETATIVE_SWALE = 7,
}

// =============================================================================
// Flow diversion
// =============================================================================

/**
 * Flow-diversion method for a `DIVIDER` node.
 */
export enum DividerType {
  /** Flow above a cutoff value is diverted. */
  CUTOFF = 0,
  /** Diverted flow equals the capacity exceedance of the main link. */
  OVERFLOW = 1,
  /** Diversion controlled by a rating curve. */
  TABULAR = 2,
  /** Weir-equation diversion. */
  WEIR = 3,
}

// =============================================================================
// Output variables
// =============================================================================

/**
 * Subcatchment output result variable indices.
 */
export enum OutSubcatchVar {
  RAINFALL = 0,
  SNOW_DEPTH = 1,
  EVAP = 2,
  INFIL = 3,
  RUNOFF = 4,
  GW_FLOW = 5,
  GW_ELEV = 6,
  SOIL_MOIST = 7,
  POLLUT_BASE = 8,
}

/**
 * Node output result variable indices.
 */
export enum OutNodeVar {
  DEPTH = 0,
  HEAD = 1,
  VOLUME = 2,
  LATERAL_INFLOW = 3,
  TOTAL_INFLOW = 4,
  OVERFLOW = 5,
  POLLUT_BASE = 6,
}

/**
 * Link output result variable indices.
 */
export enum OutLinkVar {
  FLOW = 0,
  DEPTH = 1,
  VELOCITY = 2,
  VOLUME = 3,
  CAPACITY = 4,
  POLLUT_BASE = 5,
}

// =============================================================================
// Forcing
// =============================================================================

/**
 * Forcing application mode.
 *
 * Determines how a forced value is combined with the model-computed value.
 * Mirrors `SWMM_ForcingMode` in `openswmm_forcing.h`.
 */
export enum ForcingMode {
  /** Replace the computed value entirely. */
  REPLACE = 1,
  /** Add the forced value to the computed value. */
  ADD = 2,
}

/**
 * Object type codes used with {@link Forcing.clear}.
 */
export enum ForcingTarget {
  /** Node forcing. */
  NODE = 0,
  /** Link forcing. */
  LINK = 1,
  /** Subcatchment forcing. */
  SUBCATCH = 2,
  /** Rain gage forcing. */
  GAGE = 3,
  /** System-wide climate forcing (temperature, wind). */
  CLIMATE = 4,
}

// =============================================================================
// Patterns
// =============================================================================

/**
 * Time pattern type.
 */
export enum PatternType {
  MONTHLY = 0,
  DAILY = 1,
  HOURLY = 2,
  WEEKEND = 3,
}

// =============================================================================
// Mass-balance totals
// =============================================================================

/**
 * Runoff mass balance component codes.
 */
export enum RunoffTotal {
  RAINFALL = 0,
  EVAP = 1,
  INFIL = 2,
  RUNOFF = 3,
  SNOWREMOV = 4,
  INITSTORE = 5,
  FINALSTORE = 6,
}

/**
 * Routing mass balance component codes.
 */
export enum RoutingTotal {
  DRY_WEATHER = 0,
  WET_WEATHER = 1,
  GW_INFLOW = 2,
  RDII = 3,
  EXTERNAL = 4,
  FLOODING = 5,
  OUTFLOW = 6,
  EVAP_LOSS = 7,
  SEEP_LOSS = 8,
  INIT_STORAGE = 9,
  FINAL_STORAGE = 10,
  FORCING_INFLOW = 11,
}

// =============================================================================
// File path roles
// =============================================================================

/**
 * External-file slot selector for `swmm_file_path_get/set`.
 */
export enum FilePathRole {
  RAINFALL = 1,
  RUNOFF = 2,
  RDII = 3,
  INFLOWS = 4,
  OUTFLOWS = 5,
  HOTSTART_USE = 6,
  CLIMATE_TEMP = 7,
  HOTSTART_SAVE = 8,
  RAINGAGE_DATA = 9,
  TIMESERIES_DATA = 10,
}

/**
 * User-flag schema value type.
 */
export enum UserFlagType {
  BOOLEAN = 0,
  INTEGER = 1,
  REAL = 2,
  STRING = 3,
}
