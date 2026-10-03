/**
 * @file solver.test.ts
 * @brief Unit tests for the OpenSWMM WASM binding TypeScript layer.
 *
 * @details These tests validate the TypeScript wrapper logic — enum values,
 * error class hierarchy, helper utilities, and the module's public API
 * surface — without requiring the compiled WASM binary.
 *
 * The tests use a lightweight mock of `OpenSwmmWasmModule` so they run in
 * any Node 18+ environment without Emscripten.
 *
 * @author   Caleb Buahin <caleb.buahin@gmail.com>
 * @copyright Copyright (c) 2026 Caleb Buahin. All rights reserved.
 * @license  Apache-2.0
 */

import { describe, it, expect } from "vitest";

import {
  // Enums
  ErrorCode,
  EngineState,
  NodeType,
  LinkType,
  FlowUnits,
  ForcingMode,
  ForcingPersist,
  ForcingTarget,
  XSectShape,
  // Errors
  EngineError,
  BadHandleError,
  BadIndexError,
  BadParamError,
  LifecycleError,
  HotStartError,
  FileError,
  ParseError,
  NumericalError,
  CRSError,
  DependencyError,
  ElementNotFoundError,
  StaleObjectError,
  raiseForCode,
  // Utilities
  oadateToDate,
  dateToOadate,
  // Classes (for type shape tests)
  Solver,
  ModelBuilder,
  Nodes,
  Links,
  Subcatchments,
  Gages,
  Controls,
  Forcing,
} from "../src/js/index.js";
import type { OpenSwmmWasmModule } from "../src/js/index.js";

// =============================================================================
// Enum parity tests
// =============================================================================

describe("ErrorCode", () => {
  it("has OK = 0", () => expect(ErrorCode.OK).toBe(0));
  it("has BADHANDLE = 7", () => expect(ErrorCode.BADHANDLE).toBe(7));
  it("has BADINDEX = 8", () => expect(ErrorCode.BADINDEX).toBe(8));
  it("has INTERNAL = 99", () => expect(ErrorCode.INTERNAL).toBe(99));
});

describe("EngineState", () => {
  it("NONE = 0", () => expect(EngineState.NONE).toBe(0));
  it("CREATED = 1", () => expect(EngineState.CREATED).toBe(1));
  it("RUNNING = 5", () => expect(EngineState.RUNNING).toBe(5));
  it("BUILDING = 8", () => expect(EngineState.BUILDING).toBe(8));
});

describe("NodeType", () => {
  it("JUNCTION = 0", () => expect(NodeType.JUNCTION).toBe(0));
  it("OUTFALL = 1", () => expect(NodeType.OUTFALL).toBe(1));
  it("STORAGE = 2", () => expect(NodeType.STORAGE).toBe(2));
  it("DIVIDER = 3", () => expect(NodeType.DIVIDER).toBe(3));
});

describe("LinkType", () => {
  it("CONDUIT = 0", () => expect(LinkType.CONDUIT).toBe(0));
  it("PUMP = 1", () => expect(LinkType.PUMP).toBe(1));
  it("ORIFICE = 2", () => expect(LinkType.ORIFICE).toBe(2));
  it("WEIR = 3", () => expect(LinkType.WEIR).toBe(3));
  it("OUTLET = 4", () => expect(LinkType.OUTLET).toBe(4));
});

describe("FlowUnits", () => {
  it("CFS = 0", () => expect(FlowUnits.CFS).toBe(0));
  it("CMS = 3", () => expect(FlowUnits.CMS).toBe(3));
  it("MLD = 5", () => expect(FlowUnits.MLD).toBe(5));
});

describe("ForcingMode", () => {
  it("REPLACE = 1", () => expect(ForcingMode.REPLACE).toBe(1));
  it("ADD = 2", () => expect(ForcingMode.ADD).toBe(2));
});

describe("ForcingPersist", () => {
  it("RESET = 0", () => expect(ForcingPersist.RESET).toBe(0));
  it("PERSIST = 1", () => expect(ForcingPersist.PERSIST).toBe(1));
});

describe("ForcingTarget", () => {
  it("NODE = 0", () => expect(ForcingTarget.NODE).toBe(0));
  it("GAGE = 3", () => expect(ForcingTarget.GAGE).toBe(3));
  it("CLIMATE = 4", () => expect(ForcingTarget.CLIMATE).toBe(4));
});

describe("XSectShape", () => {
  it("CIRCULAR = 0", () => expect(XSectShape.CIRCULAR).toBe(0));
  it("IRREGULAR = 21", () => expect(XSectShape.IRREGULAR).toBe(21));
  it("FORCE_MAIN = 23", () => expect(XSectShape.FORCE_MAIN).toBe(23));
  it("DUMMY = 25", () => expect(XSectShape.DUMMY).toBe(25));
});

// =============================================================================
// Error hierarchy tests
// =============================================================================

describe("EngineError", () => {
  it("is an instance of Error", () => {
    const e = new EngineError(99, "test");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(EngineError);
  });

  it("stores the code", () => {
    const e = new EngineError(8, "bad idx");
    expect(e.code).toBe(8);
    expect(e.message).toBe("bad idx");
  });

  it("defaults message to SWMM error {code}", () => {
    const e = new EngineError(14);
    expect(e.message).toBe("SWMM error 14");
  });

  it("resolves known codeEnum", () => {
    const e = new EngineError(ErrorCode.BADINDEX);
    expect(e.codeEnum).toBe(ErrorCode.BADINDEX);
  });

  it("falls back to INTERNAL for unknown code", () => {
    const e = new EngineError(12345);
    expect(e.codeEnum).toBe(ErrorCode.INTERNAL);
  });
});

describe("Error subclasses", () => {
  it("BadHandleError extends EngineError", () => {
    const e = new BadHandleError();
    expect(e).toBeInstanceOf(EngineError);
    expect(e).toBeInstanceOf(BadHandleError);
    expect(e.code).toBe(ErrorCode.BADHANDLE);
  });

  it("BadIndexError extends EngineError", () => {
    const e = new BadIndexError();
    expect(e).toBeInstanceOf(EngineError);
    expect(e).toBeInstanceOf(BadIndexError);
    expect(e.code).toBe(ErrorCode.BADINDEX);
  });

  it("BadParamError extends EngineError", () => {
    const e = new BadParamError();
    expect(e.code).toBe(ErrorCode.BADPARAM);
  });

  it("LifecycleError extends EngineError", () => {
    const e = new LifecycleError();
    expect(e.code).toBe(ErrorCode.LIFECYCLE);
  });

  it("HotStartError extends EngineError", () => {
    const e = new HotStartError();
    expect(e.code).toBe(ErrorCode.HOTSTART);
  });

  it("FileError extends EngineError", () => {
    const e = new FileError(ErrorCode.INPFILE);
    expect(e.code).toBe(ErrorCode.INPFILE);
    expect(e).toBeInstanceOf(EngineError);
  });

  it("ParseError extends EngineError", () => {
    const e = new ParseError();
    expect(e.code).toBe(ErrorCode.PARSE);
  });

  it("NumericalError extends EngineError", () => {
    const e = new NumericalError();
    expect(e.code).toBe(ErrorCode.NUMERICAL);
  });

  it("CRSError extends EngineError", () => {
    const e = new CRSError();
    expect(e.code).toBe(ErrorCode.CRS);
  });

  it("DependencyError extends EngineError", () => {
    const e = new DependencyError();
    expect(e.code).toBe(ErrorCode.DEPENDENCY);
  });

  it("ElementNotFoundError extends BadIndexError", () => {
    const e = new ElementNotFoundError("J1");
    expect(e).toBeInstanceOf(BadIndexError);
    expect(e).toBeInstanceOf(EngineError);
    expect(e.elementId).toBe("J1");
  });

  it("StaleObjectError extends LifecycleError", () => {
    const e = new StaleObjectError();
    expect(e).toBeInstanceOf(LifecycleError);
    expect(e).toBeInstanceOf(EngineError);
  });
});

// =============================================================================
// raiseForCode
// =============================================================================

describe("raiseForCode", () => {
  it("is a no-op for code 0", () => {
    expect(() => raiseForCode(0)).not.toThrow();
  });

  it("throws BadHandleError for BADHANDLE", () => {
    expect(() => raiseForCode(ErrorCode.BADHANDLE)).toThrow(BadHandleError);
  });

  it("throws BadIndexError for BADINDEX", () => {
    expect(() => raiseForCode(ErrorCode.BADINDEX)).toThrow(BadIndexError);
  });

  it("throws BadParamError for BADPARAM", () => {
    expect(() => raiseForCode(ErrorCode.BADPARAM)).toThrow(BadParamError);
  });

  it("throws LifecycleError for LIFECYCLE", () => {
    expect(() => raiseForCode(ErrorCode.LIFECYCLE)).toThrow(LifecycleError);
  });

  it("throws FileError for INPFILE", () => {
    expect(() => raiseForCode(ErrorCode.INPFILE)).toThrow(FileError);
  });

  it("throws ParseError for PARSE", () => {
    expect(() => raiseForCode(ErrorCode.PARSE)).toThrow(ParseError);
  });

  it("throws NumericalError for NUMERICAL", () => {
    expect(() => raiseForCode(ErrorCode.NUMERICAL)).toThrow(NumericalError);
  });

  it("throws EngineError for unknown code", () => {
    expect(() => raiseForCode(9999)).toThrow(EngineError);
  });

  it("includes the supplied message", () => {
    try {
      raiseForCode(ErrorCode.BADINDEX, "custom message");
      expect(true).toBe(false); // should not reach here
    } catch (e) {
      expect((e as EngineError).message).toBe("custom message");
    }
  });
});

// =============================================================================
// OADate helpers
// =============================================================================

describe("oadateToDate / dateToOadate", () => {
  it("oadateToDate(0) returns 30 Dec 1899", () => {
    const d = oadateToDate(0);
    expect(d.getUTCFullYear()).toBe(1899);
    expect(d.getUTCMonth()).toBe(11); // December
    expect(d.getUTCDate()).toBe(30);
  });

  it("oadateToDate(1) returns 31 Dec 1899", () => {
    const d = oadateToDate(1);
    expect(d.getUTCFullYear()).toBe(1899);
    expect(d.getUTCMonth()).toBe(11);
    expect(d.getUTCDate()).toBe(31);
  });

  it("roundtrips through dateToOadate", () => {
    const now = new Date(Date.UTC(2024, 0, 15, 12, 0, 0));
    const roundtripped = oadateToDate(dateToOadate(now));
    expect(Math.abs(roundtripped.getTime() - now.getTime())).toBeLessThan(1000);
  });
});

// =============================================================================
// Mock-based Solver and collection tests
// =============================================================================

/**
 * Build a minimal mock of the WASM module that satisfies `OpenSwmmWasmModule`.
 * Only the methods needed for the tested code paths are implemented.
 */
function makeMockModule(): OpenSwmmWasmModule {
  const heap: Record<number, number> = {};
  let nextPtr = 1000;

  const mod = {
    FS: {
      mkdir: () => {},
      writeFile: () => {},
      readFile: (path: string, opts?: unknown) => {
        if (opts && (opts as {encoding: string}).encoding === "utf8") return "";
        return new Uint8Array(0);
      },
      unlink: () => {},
    },

    // Engine lifecycle
    _swmm_engine_create: () => 42,
    _swmm_engine_open: () => 0,
    _swmm_engine_initialize: () => 0,
    _swmm_engine_start: () => 0,
    _swmm_engine_step: (h: number, ptr: number) => {
      heap[ptr] = 0; // elapsed = 0 → simulation ended
      return 0;
    },
    _swmm_engine_stride: (h: number, n: number, ptr: number) => {
      heap[ptr] = 0;
      return 0;
    },
    _swmm_engine_end: () => 0,
    _swmm_engine_report: () => 0,
    _swmm_engine_close: () => 0,
    _swmm_engine_destroy: () => {},
    _swmm_engine_set_lenient_open: () => {},
    _swmm_engine_get_state: (h: number, ptr: number) => {
      heap[ptr] = EngineState.RUNNING;
      return 0;
    },

    // Error / timing
    _swmm_get_last_error: () => 0,
    _swmm_get_last_error_msg: () => "",
    _swmm_error_message: (code: number) => `Error ${code}`,
    _swmm_get_error_count: () => 0,
    _swmm_get_warning_count: () => 0,
    _swmm_get_start_time: (h: number, ptr: number) => { heap[ptr] = 45296.0; return 0; },
    _swmm_get_end_time: (h: number, ptr: number) => { heap[ptr] = 45297.0; return 0; },
    _swmm_get_current_time: (h: number, ptr: number) => { heap[ptr] = 45296.5; return 0; },
    _swmm_get_routing_step: (h: number, ptr: number) => { heap[ptr] = 300; return 0; },
    _swmm_get_flow_units: (h: number, ptr: number) => { heap[ptr] = FlowUnits.CMS; return 0; },
    _swmm_get_unit_system: (h: number, ptr: number) => { heap[ptr] = 1; return 0; },

    // Nodes
    _swmm_node_count: () => 3,
    _swmm_node_index: (h: number, id: string) => id === "J1" ? 0 : id === "J2" ? 1 : -1,
    _swmm_node_id: (h: number, idx: number) => ["J1", "J2", "OUT"][idx] ?? "",
    _swmm_node_get_type: (h: number, i: number, ptr: number) => { heap[ptr] = NodeType.JUNCTION; return 0; },
    _swmm_node_get_depth: (h: number, i: number, ptr: number) => { heap[ptr] = 1.5; return 0; },
    _swmm_node_set_depth: () => 0,
    _swmm_node_get_head: (h: number, i: number, ptr: number) => { heap[ptr] = 10.5; return 0; },
    _swmm_node_get_volume: (h: number, i: number, ptr: number) => { heap[ptr] = 5.0; return 0; },
    _swmm_node_get_lateral_inflow: (h: number, i: number, ptr: number) => { heap[ptr] = 0.1; return 0; },
    _swmm_node_set_lateral_inflow: () => 0,
    _swmm_node_get_overflow: (h: number, i: number, ptr: number) => { heap[ptr] = 0.0; return 0; },
    _swmm_node_get_inflow: (h: number, i: number, ptr: number) => { heap[ptr] = 0.2; return 0; },
    _swmm_node_get_losses: (h: number, i: number, ptr: number) => { heap[ptr] = 0.0; return 0; },
    _swmm_node_get_outflow: (h: number, i: number, ptr: number) => { heap[ptr] = 0.2; return 0; },
    _swmm_node_get_invert_elev: (h: number, i: number, ptr: number) => { heap[ptr] = 9.0; return 0; },
    _swmm_node_set_invert_elev: () => 0,
    _swmm_node_get_max_depth: (h: number, i: number, ptr: number) => { heap[ptr] = 3.0; return 0; },
    _swmm_node_set_max_depth: () => 0,
    _swmm_node_set_head_boundary: () => 0,
    _swmm_node_get_stat_max_depth: (h: number, i: number, ptr: number) => { heap[ptr] = 2.0; return 0; },
    _swmm_node_get_stat_max_overflow: (h: number, i: number, ptr: number) => { heap[ptr] = 0.5; return 0; },
    _swmm_node_get_stat_vol_flooded: (h: number, i: number, ptr: number) => { heap[ptr] = 100.0; return 0; },
    _swmm_node_get_stat_time_flooded: (h: number, i: number, ptr: number) => { heap[ptr] = 3600.0; return 0; },

    // Links
    _swmm_link_count: () => 2,
    _swmm_link_index: (h: number, id: string) => id === "C1" ? 0 : id === "C2" ? 1 : -1,
    _swmm_link_id: (h: number, idx: number) => ["C1", "C2"][idx] ?? "",
    _swmm_link_get_type: (h: number, i: number, ptr: number) => { heap[ptr] = LinkType.CONDUIT; return 0; },
    _swmm_link_get_flow: (h: number, i: number, ptr: number) => { heap[ptr] = 0.3; return 0; },
    _swmm_link_set_flow: () => 0,
    _swmm_link_get_depth: (h: number, i: number, ptr: number) => { heap[ptr] = 0.5; return 0; },
    _swmm_link_get_velocity: (h: number, i: number, ptr: number) => { heap[ptr] = 1.2; return 0; },
    _swmm_link_get_capacity: (h: number, i: number, ptr: number) => { heap[ptr] = 0.6; return 0; },
    _swmm_link_get_volume: (h: number, i: number, ptr: number) => { heap[ptr] = 10.0; return 0; },
    _swmm_link_get_control_setting: (h: number, i: number, ptr: number) => { heap[ptr] = 1.0; return 0; },
    _swmm_link_set_control_setting: () => 0,
    _swmm_link_get_target_setting: (h: number, i: number, ptr: number) => { heap[ptr] = 1.0; return 0; },
    _swmm_link_set_target_setting: () => 0,
    _swmm_link_get_closed: (h: number, i: number, ptr: number) => { heap[ptr] = 0; return 0; },
    _swmm_link_set_closed: () => 0,
    _swmm_link_get_from_node: (h: number, i: number, ptr: number) => { heap[ptr] = 0; return 0; },
    _swmm_link_get_to_node: (h: number, i: number, ptr: number) => { heap[ptr] = 1; return 0; },

    // Subcatchments
    _swmm_subcatch_count: () => 1,
    _swmm_subcatch_index: (h: number, id: string) => id === "S1" ? 0 : -1,
    _swmm_subcatch_id: (h: number, idx: number) => idx === 0 ? "S1" : "",
    _swmm_subcatch_get_runoff: (h: number, i: number, ptr: number) => { heap[ptr] = 0.05; return 0; },
    _swmm_subcatch_get_area: (h: number, i: number, ptr: number) => { heap[ptr] = 10.0; return 0; },
    _swmm_subcatch_get_imperv_pct: (h: number, i: number, ptr: number) => { heap[ptr] = 50.0; return 0; },
    _swmm_subcatch_get_width: (h: number, i: number, ptr: number) => { heap[ptr] = 100.0; return 0; },
    _swmm_subcatch_get_slope: (h: number, i: number, ptr: number) => { heap[ptr] = 1.0; return 0; },
    _swmm_subcatch_get_outlet: (h: number, i: number, ptr: number) => { heap[ptr] = 0; return 0; },
    _swmm_subcatch_get_gage: (h: number, i: number, ptr: number) => { heap[ptr] = 0; return 0; },

    // Gages
    _swmm_gage_count: () => 1,
    _swmm_gage_index: (h: number, id: string) => id === "G1" ? 0 : -1,
    _swmm_gage_id: (h: number, idx: number) => idx === 0 ? "G1" : "",
    _swmm_gage_get_rainfall: (h: number, i: number, ptr: number) => { heap[ptr] = 5.0; return 0; },
    _swmm_gage_set_rainfall: () => 0,
    _swmm_gage_get_rain_type: (h: number, i: number, ptr: number) => { heap[ptr] = 0; return 0; },
    _swmm_gage_get_data_source: (h: number, i: number, ptr: number) => { heap[ptr] = 0; return 0; },
    _swmm_gage_get_scale_factor: (h: number, i: number, ptr: number) => { heap[ptr] = 1.0; return 0; },
    _swmm_gage_set_scale_factor: () => 0,
    _swmm_gage_get_rain_interval: (h: number, i: number, ptr: number) => { heap[ptr] = 900; return 0; },
    _swmm_gage_get_snow_factor: (h: number, i: number, ptr: number) => { heap[ptr] = 1.0; return 0; },

    // Controls
    _swmm_control_count: () => 0,
    _swmm_control_get_rule: () => 0,
    _swmm_control_get_id: () => 0,
    _swmm_control_add_rule: () => 0,
    _swmm_control_remove_rule: () => 0,
    _swmm_control_clear_rules: () => 0,
    _swmm_control_set_link_setting: () => 0,
    _swmm_control_set_link_status: () => 0,

    // Forcing
    _swmm_forcing_node_lat_inflow: () => 0,
    _swmm_forcing_node_head_boundary: () => 0,
    _swmm_forcing_link_flow: () => 0,
    _swmm_forcing_link_setting: () => 0,
    _swmm_forcing_subcatch_rainfall: () => 0,
    _swmm_forcing_gage_rainfall: () => 0,
    _swmm_forcing_clear: () => 0,
    _swmm_forcing_clear_all: () => 0,

    // WASM heap helpers
    _malloc: (size: number) => { const p = nextPtr; nextPtr += size + 8; return p; },
    _free: () => {},
    getValue: (ptr: number) => heap[ptr] ?? 0,
    setValue: (ptr: number, value: number) => { heap[ptr] = value; },
    UTF8ToString: (ptr: number) => "",
    stringToUTF8: () => {},
    lengthBytesUTF8: (s: string) => s.length,
    HEAP8: new Int8Array(0),
    HEAPU8: new Uint8Array(0),
    HEAP32: new Int32Array(0),
    HEAPU32: new Uint32Array(0),
    HEAPF32: new Float32Array(0),
    HEAPF64: new Float64Array(0),
    // The raw layer uses cwrap only for string-carrying functions; the mock
    // takes/returns JS strings directly, so cwrap just resolves the export.
    cwrap: (name: string) => (mod as Record<string, unknown>)[`_${name}`] as (...a: unknown[]) => unknown,
    addFunction: () => 1,
    removeFunction: () => {},
  } satisfies OpenSwmmWasmModule;
  return mod;
}

// =============================================================================
// Solver
// =============================================================================

describe("Solver", () => {
  it("constructs without error using mock module", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(solver.handle).toBe(42);
  });

  it("throws EngineError if create returns 0", () => {
    const mod = makeMockModule();
    mod._swmm_engine_create = () => 0;
    expect(() => new Solver(mod)).toThrow(EngineError);
  });

  it("exposes domain collection properties", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(solver.nodes).toBeInstanceOf(Nodes);
    expect(solver.links).toBeInstanceOf(Links);
    expect(solver.subcatchments).toBeInstanceOf(Subcatchments);
    expect(solver.gages).toBeInstanceOf(Gages);
    expect(solver.controls).toBeInstanceOf(Controls);
    expect(solver.forcing).toBeInstanceOf(Forcing);
  });

  it("forcing passes mode and persist flag through to the C API", () => {
    const mod = makeMockModule();
    const calls: number[][] = [];
    mod._swmm_forcing_node_lat_inflow = (...args: number[]) => {
      calls.push(args);
      return 0;
    };
    const solver = new Solver(mod);
    solver.forcing.nodeLatInflow(3, 0.5);
    solver.forcing.nodeLatInflow(3, 0.5, ForcingMode.ADD, true);
    expect(calls[0].slice(1)).toEqual([3, 0.5, ForcingMode.REPLACE, ForcingPersist.RESET]);
    expect(calls[1].slice(1)).toEqual([3, 0.5, ForcingMode.ADD, ForcingPersist.PERSIST]);
  });

  it("state returns EngineState value", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(solver.state).toBe(EngineState.RUNNING);
  });

  it("flowUnits returns FlowUnits value", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(solver.flowUnits).toBe(FlowUnits.CMS);
  });

  it("routingStep returns a number", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(typeof solver.routingStep).toBe("number");
  });

  it("startDatetime returns a Date", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(solver.startDatetime).toBeInstanceOf(Date);
  });

  it("step returns 0 (end-of-sim) from mock", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(solver.step()).toBe(0);
  });

  it("stride returns 0 from mock", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(solver.stride(10)).toBe(0);
  });

  it("[Symbol.dispose] calls destroy", () => {
    const mod = makeMockModule();
    let destroyed = false;
    mod._swmm_engine_destroy = () => {
      destroyed = true;
    };
    const solver = new Solver(mod);
    solver[Symbol.dispose]();
    expect(destroyed).toBe(true);
  });
});

// =============================================================================
// Nodes collection
// =============================================================================

describe("Nodes", () => {
  it("length returns node count", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(solver.nodes.length).toBe(3);
  });

  it("get(0) returns Node with correct id", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(solver.nodes.get(0).id).toBe("J1");
  });

  it("get('J2') returns Node with index 1", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(solver.nodes.get("J2").index).toBe(1);
  });

  it("get('UNKNOWN') throws ElementNotFoundError", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(() => solver.nodes.get("UNKNOWN")).toThrow(ElementNotFoundError);
  });

  it("get(-1) throws ElementNotFoundError", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(() => solver.nodes.get(-1)).toThrow(ElementNotFoundError);
  });

  it("getIndex returns correct index", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(solver.nodes.getIndex("J1")).toBe(0);
    expect(solver.nodes.getIndex("MISSING")).toBe(-1);
  });

  it("node.depth returns a number", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(solver.nodes.get(0).depth).toBe(1.5);
  });

  it("node.type returns NodeType", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(solver.nodes.get(0).type).toBe(NodeType.JUNCTION);
  });

  it("depths bulk accessor returns Float64Array of length 3", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    const depths = solver.nodes.depths;
    expect(depths).toBeInstanceOf(Float64Array);
    expect(depths.length).toBe(3);
    expect(depths[0]).toBe(1.5);
  });

  it("is iterable", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    const ids: string[] = [];
    for (const node of solver.nodes) {
      ids.push(node.id);
    }
    expect(ids).toEqual(["J1", "J2", "OUT"]);
  });

  it("stale node throws StaleObjectError", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    const node = solver.nodes.get(0);
    solver.nodes.generation++;
    expect(() => node.depth).toThrow(StaleObjectError);
  });

  it("node.stats returns NodeStats", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    const stats = solver.nodes.get(0).stats;
    expect(typeof stats.maxDepth).toBe("number");
    expect(typeof stats.timeFlooded).toBe("number");
  });
});

// =============================================================================
// Links collection
// =============================================================================

describe("Links", () => {
  it("length = 2", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(solver.links.length).toBe(2);
  });

  it("get('C1').flow = 0.3", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(solver.links.get("C1").flow).toBe(0.3);
  });

  it("get('MISSING') throws ElementNotFoundError", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(() => solver.links.get("MISSING")).toThrow(ElementNotFoundError);
  });

  it("flows bulk accessor returns Float64Array", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(solver.links.flows).toBeInstanceOf(Float64Array);
    expect(solver.links.flows.length).toBe(2);
  });

  it("link.isClosed = false (from mock 0)", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(solver.links.get(0).isClosed).toBe(false);
  });
});

// =============================================================================
// Subcatchments, Gages, Controls, Forcing
// =============================================================================

describe("Subcatchments", () => {
  it("length = 1", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(solver.subcatchments.length).toBe(1);
  });

  it("get('S1').runoff = 0.05", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(solver.subcatchments.get("S1").runoff).toBe(0.05);
  });
});

describe("Gages", () => {
  it("length = 1", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(solver.gages.length).toBe(1);
  });

  it("get('G1').rainfall = 5.0", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(solver.gages.get("G1").rainfall).toBe(5.0);
  });
});

describe("Controls", () => {
  it("length = 0 (no rules in mock)", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(solver.controls.length).toBe(0);
  });

  it("clearRules does not throw", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(() => solver.controls.clearRules()).not.toThrow();
  });
});

describe("Forcing", () => {
  it("nodeLatInflow does not throw", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(() => solver.forcing.nodeLatInflow(0, 1.0, ForcingMode.REPLACE)).not.toThrow();
  });

  it("gageRainfall does not throw", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(() => solver.forcing.gageRainfall(0, 10.0)).not.toThrow();
  });

  it("clearAll does not throw", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(() => solver.forcing.clearAll()).not.toThrow();
  });

  it("clear(NODE, 0) does not throw", () => {
    const mod = makeMockModule();
    const solver = new Solver(mod);
    expect(() => solver.forcing.clear(ForcingTarget.NODE, 0)).not.toThrow();
  });
});


describe("native owner lifetime", () => {
  it("destroys once and rejects calls from retained views", () => {
    const mod = makeMockModule();
    let destroys = 0, reads = 0;
    mod._swmm_engine_destroy = () => { destroys++; };
    mod._swmm_node_count = () => { reads++; return 2; };
    const s = new Solver(mod);
    const node = s.nodes.get(0);
    const before = reads;
    s.destroy(); s.destroy(); s[Symbol.dispose]();
    expect(destroys).toBe(1);
    for (const access of [() => s.handle, () => s.step(), () => s.nodes.length,
      () => node.depth, () => s.forcing.clearAll(), () => s.controls.length,
      () => s.transport.targetDx]) expect(access).toThrow(EngineError);
    expect(reads).toBe(before);
  });
  it("invalidates element views on close", () => {
    const s = new Solver(makeMockModule());
    const node = s.nodes.get(0);
    s.close();
    expect(() => node.depth).toThrow(StaleObjectError);
  });
  it("invalidates builder views on ownership transfer", () => {
    const mod = makeMockModule();
    mod._swmm_engine_new = () => 42;
    const b = new ModelBuilder(mod);
    const nodes = b.nodes, t = b.transport;
    const s = b.toSolver();
    expect(() => nodes.length).toThrow(EngineError);
    expect(() => t.targetDx).toThrow(EngineError);
    expect(s.nodes.length).toBeGreaterThan(0);
    s.destroy();
  });
  it("forwards new temperature, age and seepage forcing arguments", () => {
    const mod = makeMockModule();
    const calls: number[][] = [];
    for (const name of ["node_temperature", "node_age", "link_seepage"]) {
      mod[`_swmm_forcing_${name}`] = (...args: number[]) => { calls.push(args); return 0; };
    }
    const s = new Solver(mod);
    s.forcing.nodeTemperature(1, 18, ForcingMode.ADD, true);
    s.forcing.nodeAge(2, 3600);
    s.forcing.linkSeepage(3, 0.1);
    expect(calls).toEqual([[42, 1, 18, 2, 1], [42, 2, 3600, 1, 0], [42, 3, 0.1, 1, 0]]);
  });
});


describe("new binding regression cases", () => {
  it("invalidates builder views after a structural edit", () => {
    const mod = makeMockModule();
    mod._swmm_engine_new = () => 42;
    mod._swmm_node_add = () => 0;
    const b = new ModelBuilder(mod);
    const nodes = b.nodes;
    b.addNode("J3", NodeType.JUNCTION);
    expect(() => nodes.length).toThrow(StaleObjectError);
    expect(b.nodes.length).toBeGreaterThan(0);
    b[Symbol.dispose]();
  });
  it("copies transport row buffers and frees them on native failure", () => {
    const mod = makeMockModule();
    const numbers = new Map<number, number>();
    const strings = new Map<number, string>();
    let freed = 0, fail = false;
    mod.getValue = (p: number) => numbers.get(p) ?? 0;
    mod.UTF8ToString = (p: number) => strings.get(p) ?? "";
    mod._free = () => { freed++; };
    mod._swmm_transport_boundary_count = (_h: number, p: number) => { numbers.set(p, 2); return 0; };
    mod._swmm_transport_get_boundary = (_h: number, i: number, elem: number, _el: number,
      species: number, _sl: number, isTs: number, value: number, ts: number) => {
      if (fail) return 9;
      strings.set(elem, `J${i}`); strings.set(species, "TSS"); strings.set(ts, i ? "series" : "");
      numbers.set(isTs, i); numbers.set(value, i ? 0 : 2.5);
      return 0;
    };
    const s = new Solver(mod);
    const rows = s.transport.boundaries;
    expect(rows).toEqual([
      {element: "J0", species: "TSS", isTimeseries: false, value: 2.5, timeseries: ""},
      {element: "J1", species: "TSS", isTimeseries: true, value: 0, timeseries: "series"},
    ]);
    const before = freed; fail = true;
    expect(() => s.transport.boundaries).toThrow(BadParamError);
    expect(freed - before).toBe(2); // count out-pointer and row buffers
    expect(rows[0].element).toBe("J0");
  });
});
