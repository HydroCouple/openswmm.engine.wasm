/**
 * @file errors.ts
 * @brief Exception hierarchy for the OpenSWMM Engine WebAssembly bindings.
 *
 * @details Mirrors the Python `_exceptions.py` module. Every non-zero return
 * from the C API is mapped to an `EngineError` subclass. Each subclass also
 * extends the most appropriate built-in `Error` type so callers can write
 * idiomatic handlers without importing engine-specific symbols:
 *
 * ```ts
 * try {
 *   const node = solver.nodes.get("UNKNOWN");
 * } catch (e) {
 *   if (e instanceof ElementNotFoundError) { ... }
 *   if (e instanceof RangeError)           { ... }  // same object
 * }
 * ```
 *
 * @author   Caleb Buahin <caleb.buahin@gmail.com>
 * @copyright Copyright (c) 2026 Caleb Buahin. All rights reserved.
 * @license  MIT
 */

import { ErrorCode } from "./enums.js";

// =============================================================================
// Base class
// =============================================================================

/**
 * Base class for every C API failure surfaced to JavaScript.
 */
export class EngineError extends Error {
  /** The raw `SWMM_ERR_*` integer code returned by the C API. */
  readonly code: number;
  /** The same code as an {@link ErrorCode} value (defaults to `INTERNAL`). */
  readonly codeEnum: ErrorCode;

  constructor(code: number, message?: string) {
    const resolved =
      message != null && message.length > 0
        ? message
        : `SWMM error ${code}`;
    super(resolved);
    this.name = "EngineError";
    this.code = code;
    this.codeEnum = Object.values(ErrorCode).includes(code as ErrorCode)
      ? (code as ErrorCode)
      : ErrorCode.INTERNAL;
    // Maintain correct prototype chain in transpiled ES5.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// =============================================================================
// Concrete subclasses
// =============================================================================

/**
 * Engine handle is `NULL` or invalid (`SWMM_ERR_BADHANDLE`).
 */
export class BadHandleError extends EngineError {
  constructor(message?: string) {
    super(ErrorCode.BADHANDLE, message ?? "Bad or NULL engine handle");
    this.name = "BadHandleError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Object index out of range (`SWMM_ERR_BADINDEX`).
 */
export class BadIndexError extends EngineError {
  constructor(message?: string) {
    super(ErrorCode.BADINDEX, message ?? "Index out of range");
    this.name = "BadIndexError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Invalid parameter value (`SWMM_ERR_BADPARAM`).
 */
export class BadParamError extends EngineError {
  constructor(message?: string) {
    super(ErrorCode.BADPARAM, message ?? "Invalid parameter value");
    this.name = "BadParamError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Function called in the wrong engine lifecycle state (`SWMM_ERR_LIFECYCLE`).
 */
export class LifecycleError extends EngineError {
  constructor(message?: string) {
    super(ErrorCode.LIFECYCLE, message ?? "Function called in wrong lifecycle state");
    this.name = "LifecycleError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Hot-start file error (`SWMM_ERR_HOTSTART`).
 */
export class HotStartError extends EngineError {
  constructor(message?: string) {
    super(ErrorCode.HOTSTART, message ?? "Hot start file error");
    this.name = "HotStartError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Plugin failure (`SWMM_ERR_PLUGIN`).
 */
export class PluginError extends EngineError {
  constructor(message?: string) {
    super(ErrorCode.PLUGIN, message ?? "Plugin error");
    this.name = "PluginError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * File I/O failure — input, report, output, or generic I/O.
 *
 * Covers `SWMM_ERR_INPFILE`, `SWMM_ERR_RPTFILE`, `SWMM_ERR_OUTFILE`, and
 * `SWMM_ERR_IO`.
 */
export class FileError extends EngineError {
  constructor(code: number, message?: string) {
    super(code, message ?? "File I/O error");
    this.name = "FileError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Input file parse error (`SWMM_ERR_PARSE`).
 */
export class ParseError extends EngineError {
  constructor(message?: string) {
    super(ErrorCode.PARSE, message ?? "Input file parse error");
    this.name = "ParseError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Numerical failure such as divergence (`SWMM_ERR_NUMERICAL`).
 */
export class NumericalError extends EngineError {
  constructor(message?: string) {
    super(ErrorCode.NUMERICAL, message ?? "Numerical error");
    this.name = "NumericalError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Coordinate reference system error (`SWMM_ERR_CRS`).
 */
export class CRSError extends EngineError {
  constructor(message?: string) {
    super(ErrorCode.CRS, message ?? "Coordinate reference system error");
    this.name = "CRSError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Object has dependents that block the requested operation
 * (`SWMM_ERR_DEPENDENCY`).
 */
export class DependencyError extends EngineError {
  constructor(message?: string) {
    super(ErrorCode.DEPENDENCY, message ?? "Object has dependents");
    this.name = "DependencyError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * A string element ID was not found in a collection.
 *
 * Inherits from {@link BadIndexError} (hence {@link EngineError}) so callers
 * that want to catch engine faults specifically can do so, while also being
 * a `RangeError` for idiomatic JavaScript handling.
 */
export class ElementNotFoundError extends BadIndexError {
  /** The offending element identifier. */
  readonly elementId: string | number;

  constructor(elementId: string | number, message?: string) {
    super(message ?? `Element not found: ${String(elementId)}`);
    this.name = "ElementNotFoundError";
    this.elementId = elementId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Wrapper object refers to a model state that has since changed.
 *
 * Raised by domain wrappers ({@link Node}, {@link Link}, …) when the
 * collection's generation counter has advanced past the wrapper's. Re-look up
 * the object by id from the current collection to recover.
 */
export class StaleObjectError extends LifecycleError {
  constructor(
    message = "Stale wrapper: the model changed since this object was looked up",
  ) {
    super(message);
    this.name = "StaleObjectError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// =============================================================================
// Error mapping helper
// =============================================================================

/** Internal map from `ErrorCode` to the exception class to instantiate. */
const CODE_TO_EXCEPTION: Map<ErrorCode, (msg?: string) => EngineError> = new Map(
  [
    [ErrorCode.NOMEM,      (m) => new EngineError(ErrorCode.NOMEM,      m ?? "Out of memory")],
    [ErrorCode.INPFILE,    (m) => new FileError(ErrorCode.INPFILE,      m)],
    [ErrorCode.RPTFILE,    (m) => new FileError(ErrorCode.RPTFILE,      m)],
    [ErrorCode.OUTFILE,    (m) => new FileError(ErrorCode.OUTFILE,      m)],
    [ErrorCode.PARSE,      (m) => new ParseError(m)],
    [ErrorCode.LIFECYCLE,  (m) => new LifecycleError(m)],
    [ErrorCode.BADHANDLE,  (m) => new BadHandleError(m)],
    [ErrorCode.BADINDEX,   (m) => new BadIndexError(m)],
    [ErrorCode.BADPARAM,   (m) => new BadParamError(m)],
    [ErrorCode.PLUGIN,     (m) => new PluginError(m)],
    [ErrorCode.IO,         (m) => new FileError(ErrorCode.IO,           m)],
    [ErrorCode.HOTSTART,   (m) => new HotStartError(m)],
    [ErrorCode.CRS,        (m) => new CRSError(m)],
    [ErrorCode.NUMERICAL,  (m) => new NumericalError(m)],
    [ErrorCode.DEPENDENCY, (m) => new DependencyError(m)],
    [ErrorCode.INTERNAL,   (m) => new EngineError(ErrorCode.INTERNAL,   m ?? "Internal engine error")],
  ] as const,
);

/**
 * Throw the correct {@link EngineError} subclass for `code`.
 *
 * `code === 0` is a no-op.
 *
 * @param code    The C API return code.
 * @param message Optional human-readable override.
 */
export function raiseForCode(code: number, message?: string): void {
  if (code === 0) return;
  let codeEnum: ErrorCode;
  try {
    codeEnum = code as ErrorCode;
  } catch {
    codeEnum = ErrorCode.INTERNAL;
  }
  const factory = CODE_TO_EXCEPTION.get(codeEnum);
  throw factory ? factory(message) : new EngineError(code, message);
}
