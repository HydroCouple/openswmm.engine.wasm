/**
 * @file SolverViews.ts
 * @brief `solver.options`, `solver.userflags` and `solver.events` (Python
 *        `SimulationOptions`, `UserFlags`, `EventsView` in `openswmm.engine._solver`).
 *
 * Python's mappings become `get`/`set`/`delete`/`has`/`length` and iteration
 * over keys; an unknown key throws `ElementNotFoundError` (Python: `KeyError`).
 *
 * @license  Apache-2.0
 */

import { UserFlagType } from "./enums.js";
import { BadParamError, ElementNotFoundError, raiseForCode } from "./errors.js";
import { datetimeToOadate, oadateToDatetime } from "./dates.js";
import { checkedAlloc, withCString, withCStrings, withInt } from "./mem.js";
import type { UserFlagDef } from "./ModelBuilder.js";
import type { RawApi } from "./raw.js";
import type { Solver } from "./Solver.js";
import type { OpenSwmmWasmModule } from "./types.js";

/** What the views need from their solver. */
interface Host {
  readonly mod: OpenSwmmWasmModule;
  readonly raw: RawApi;
  readonly handle: number;
  readonly solver: Solver;
}

const KEY_BUFFER = 256;
const VALUE_BUFFER = 1024;

/** A user-flag value: BOOLEAN, INTEGER/REAL or STRING. */
export type UserFlagValue = boolean | number | string;

/** One `[EVENTS]` entry (Python `Event`). */
export interface SimulationEvent {
  start: Date;
  end: Date;
}

// =============================================================================
// Options
// =============================================================================

/** The `[OPTIONS_EXT]` block (Python `_OptionsExtView`), under `solver.options.ext`. */
export class OptionsExtView {
  /** @internal */
  constructor(private readonly _host: Host) {}

  /** Value of an extended option. @throws ElementNotFoundError for an unknown key */
  get(key: string): string {
    const { mod, raw, handle } = this._host;
    try {
      return withCString(mod, VALUE_BUFFER, (buf, len) =>
        raw.swmm_options_get_ext(handle, key, buf, len),
      );
    } catch (err) {
      if (err instanceof BadParamError) throw new ElementNotFoundError(key);
      throw err;
    }
  }

  /** Set an extended option (non-strings are converted with `String()`). */
  set(key: string, value: unknown): void {
    const { raw, handle } = this._host;
    raiseForCode(
      raw.swmm_options_set_ext(handle, key, typeof value === "string" ? value : String(value)),
    );
  }

  /** Extended options cannot be deleted. @throws TypeError */
  delete(key: string): never {
    void key;
    throw new TypeError("SWMM extended options cannot be deleted");
  }

  /** True when `key` is an extended option. */
  has(key: string): boolean {
    try {
      this.get(key);
      return true;
    } catch (err) {
      if (err instanceof ElementNotFoundError) return false;
      throw err;
    }
  }

  /** Number of extended option keys. */
  get length(): number {
    const { mod, raw, handle } = this._host;
    return withInt(mod, (p) => raw.swmm_options_ext_key_count(handle, p));
  }

  /** The extended option keys. */
  [Symbol.iterator](): Iterator<string> {
    const { mod, raw, handle } = this._host;
    const keys = Array.from({ length: this.length }, (_, i) =>
      withCString(mod, KEY_BUFFER, (buf, len) => raw.swmm_options_ext_key_at(handle, i, buf, len)),
    );
    return keys[Symbol.iterator]();
  }
}

/**
 * `solver.options`: the string-keyed `[OPTIONS]` block, plus typed shortcuts
 * for the dates, the routing step and the CRS.
 *
 * ```ts
 * solver.options.get("FLOW_UNITS");        // "CFS"
 * solver.options.set("ROUTING_STEP", 30);
 * solver.options.startDatetime;            // Date (UTC)
 * ```
 */
export class SimulationOptions {
  /** The `[OPTIONS_EXT]` block. */
  readonly ext: OptionsExtView;

  /** @internal */
  constructor(private readonly _host: Host) {
    this.ext = new OptionsExtView(_host);
  }

  /** Value of an option. @throws ElementNotFoundError for an unknown key */
  get(key: string): string {
    const { mod, raw, handle } = this._host;
    try {
      return withCString(mod, VALUE_BUFFER, (buf, len) =>
        raw.swmm_options_get(handle, key, buf, len),
      );
    } catch (err) {
      if (err instanceof BadParamError) throw new ElementNotFoundError(key);
      throw err;
    }
  }

  /** Set an option (non-strings are converted with `String()`). */
  set(key: string, value: unknown): void {
    const { raw, handle } = this._host;
    raiseForCode(
      raw.swmm_options_set(handle, key, typeof value === "string" ? value : String(value)),
    );
  }

  /** Options cannot be deleted; assign an empty string instead. @throws TypeError */
  delete(key: string): never {
    void key;
    throw new TypeError("SWMM options cannot be deleted; assign an empty string instead");
  }

  /** True when `key` is an option. */
  has(key: string): boolean {
    try {
      this.get(key);
      return true;
    } catch (err) {
      if (err instanceof ElementNotFoundError) return false;
      throw err;
    }
  }

  /** Number of option keys the engine knows. */
  get length(): number {
    return this._host.raw.swmm_options_key_count();
  }

  /** The option keys. */
  [Symbol.iterator](): Iterator<string> {
    const { mod, raw } = this._host;
    const keys = Array.from({ length: this.length }, (_, i) =>
      withCString(mod, KEY_BUFFER, (buf, len) => raw.swmm_options_key_at(i, buf, len)),
    );
    return keys[Symbol.iterator]();
  }

  /** Configured simulation start (`[OPTIONS] START_DATE/TIME`). */
  get startDatetime(): Date {
    return this._host.solver.startDatetime;
  }
  set startDatetime(value: Date) {
    this._host.solver.startDatetime = value;
  }

  /** Configured simulation end. */
  get endDatetime(): Date {
    return this._host.solver.endDatetime;
  }
  set endDatetime(value: Date) {
    this._host.solver.endDatetime = value;
  }

  /** Configured report start. */
  get reportStartDatetime(): Date {
    return this._host.solver.reportStartDatetime;
  }
  set reportStartDatetime(value: Date) {
    this._host.solver.reportStartDatetime = value;
  }

  /** Routing time step in seconds. */
  get routingStep(): number {
    return this._host.solver.routingStep;
  }

  /** Coordinate reference system of the model. */
  get crs(): string {
    return this._host.solver.crs;
  }
}

// =============================================================================
// User flags
// =============================================================================

/**
 * `solver.userflags`: user flags by name. Reading tries BOOLEAN, then
 * INTEGER, REAL and STRING. Writing a boolean or string sets that type; a
 * number keeps the flag's declared INTEGER or REAL type, and otherwise is an
 * INTEGER when it is a whole number and a REAL when not (JavaScript has one
 * number type). `delete` removes the definition and every per-object value.
 */
export class UserFlags {
  /** @internal */
  constructor(private readonly _host: Host) {}

  /** Value of a flag. @throws ElementNotFoundError when the flag has no model value */
  get(key: string): UserFlagValue {
    const { mod, raw, handle } = this._host;
    const p = checkedAlloc(mod, 8);
    try {
      if (raw.swmm_userflag_get_bool(handle, key, p) === 0) return mod.HEAP32[p >> 2] !== 0;
      if (raw.swmm_userflag_get_int(handle, key, p) === 0) return mod.HEAP32[p >> 2];
      if (raw.swmm_userflag_get_real(handle, key, p) === 0) return mod.HEAPF64[p >> 3];
    } finally {
      mod._free(p);
    }
    const text = this.getValue("MODEL", "", key);
    if (text === null) throw new ElementNotFoundError(key);
    return text;
  }

  /** Set a flag's model value; see the class notes for how the type is chosen. */
  set(key: string, value: UserFlagValue): void {
    const { raw, handle } = this._host;
    if (typeof value === "boolean") {
      raiseForCode(raw.swmm_userflag_set_bool(handle, key, value ? 1 : 0));
    } else if (typeof value === "number") {
      const declared = this.definitions().find((d) => d.name === key)?.type;
      const integer =
        declared === UserFlagType.INTEGER ||
        (declared !== UserFlagType.REAL && Number.isInteger(value));
      raiseForCode(
        integer
          ? raw.swmm_userflag_set_int(handle, key, value)
          : raw.swmm_userflag_set_real(handle, key, value),
      );
    } else if (typeof value === "string") {
      raiseForCode(raw.swmm_userflag_define(handle, key, UserFlagType.STRING, ""));
      raiseForCode(raw.swmm_userflag_value_set(handle, "MODEL", "", key, value));
    } else {
      throw new TypeError(`user flag value must be boolean, number or string; got ${typeof value}`);
    }
  }

  /** Remove a flag's definition and every per-object value. @throws ElementNotFoundError */
  delete(key: string): void {
    const { raw, handle } = this._host;
    if (raw.swmm_userflag_undefine(handle, key) !== 0) throw new ElementNotFoundError(key);
  }

  /** True when the flag has a model value. */
  has(key: string): boolean {
    try {
      this.get(key);
      return true;
    } catch (err) {
      if (err instanceof ElementNotFoundError) return false;
      throw err;
    }
  }

  /** Number of flag definitions. */
  get length(): number {
    const { mod, raw, handle } = this._host;
    return withInt(mod, (p) => raw.swmm_userflag_def_count(handle, p));
  }

  /** The defined flag names, in definition order. */
  [Symbol.iterator](): Iterator<string> {
    const names = this.definitions().map((d) => d.name);
    return names[Symbol.iterator]();
  }

  /** Define or redefine a flag (`[USER_FLAGS]`); existing per-object values are kept. */
  define(name: string, type: UserFlagType | number, description = ""): void {
    const { raw, handle } = this._host;
    raiseForCode(raw.swmm_userflag_define(handle, name, type, description));
  }

  /** Remove a flag definition and all its per-object values. */
  undefine(name: string): void {
    const { raw, handle } = this._host;
    raiseForCode(raw.swmm_userflag_undefine(handle, name));
  }

  /** Every flag definition, in insertion order. */
  definitions(): UserFlagDef[] {
    const { mod, raw, handle } = this._host;
    const typeOut = checkedAlloc(mod, 4);
    try {
      return Array.from({ length: this.length }, (_, i) => {
        const [name, description] = withCStrings(mod, KEY_BUFFER, 2, ([n, d], len) =>
          raw.swmm_userflag_def_get(handle, i, n, len, typeOut, d, len),
        );
        return { name, type: mod.HEAP32[typeOut >> 2], description };
      });
    } finally {
      mod._free(typeOut);
    }
  }

  /**
   * A flag's value on one object, as INP text (BOOLEAN `YES`/`NO`, INTEGER,
   * REAL `%g`, STRING verbatim), or `null` when unassigned. `objType` is e.g.
   * `"NODE"` or `"SUBCATCHMENT"` (case-insensitive).
   */
  getValue(objType: string, objName: string, flagName: string): string | null {
    const { mod, raw, handle } = this._host;
    const found = checkedAlloc(mod, 4);
    try {
      mod.HEAP32[found >> 2] = 0;
      const text = withCString(mod, VALUE_BUFFER, (buf, len) =>
        raw.swmm_userflag_value_get(handle, objType, objName, flagName, buf, len, found),
      );
      return mod.HEAP32[found >> 2] ? text : null;
    } finally {
      mod._free(found);
    }
  }

  /** Assign a flag value to one object from text, parsed as the flag's declared type. */
  setValue(objType: string, objName: string, flagName: string, value: string): void {
    const { raw, handle } = this._host;
    raiseForCode(raw.swmm_userflag_value_set(handle, objType, objName, flagName, value));
  }

  /** Remove a flag value from one object (idempotent). */
  clearValue(objType: string, objName: string, flagName: string): void {
    const { raw, handle } = this._host;
    raiseForCode(raw.swmm_userflag_value_clear(handle, objType, objName, flagName));
  }
}

// =============================================================================
// Events
// =============================================================================

type EventInput = SimulationEvent | [Date, Date];

function unpack(value: EventInput): [number, number] {
  const [start, end] = Array.isArray(value) ? value : [value.start, value.end];
  if (!(start instanceof Date) || !(end instanceof Date)) {
    throw new TypeError("an event is {start, end} or [start, end] with Date values");
  }
  return [datetimeToOadate(start), datetimeToOadate(end)];
}

/** `solver.events`: the `[EVENTS]` periods, a mutable list of {@link SimulationEvent}. */
export class EventsView {
  /** @internal */
  constructor(private readonly _host: Host) {}

  /** Number of events. */
  get length(): number {
    const { mod, raw, handle } = this._host;
    return withInt(mod, (p) => raw.swmm_events_count(handle, p));
  }

  /** @internal */
  private _index(idx: number): number {
    const n = this.length;
    const i = idx < 0 ? idx + n : idx;
    if (!Number.isInteger(i) || i < 0 || i >= n) throw new ElementNotFoundError(idx);
    return i;
  }

  /** The event at `idx` (negative counts from the end). */
  get(idx: number): SimulationEvent {
    const { mod, raw, handle } = this._host;
    const i = this._index(idx);
    const p = checkedAlloc(mod, 16);
    try {
      raiseForCode(raw.swmm_events_get(handle, i, p, p + 8));
      return {
        start: oadateToDatetime(mod.HEAPF64[p >> 3]),
        end: oadateToDatetime(mod.HEAPF64[(p >> 3) + 1]),
      };
    } finally {
      mod._free(p);
    }
  }

  /** Replace the event at `idx`. */
  set(idx: number, value: EventInput): void {
    const { raw, handle } = this._host;
    const [s, e] = unpack(value);
    raiseForCode(raw.swmm_events_set(handle, this._index(idx), s, e));
  }

  /** Remove the event at `idx`. */
  delete(idx: number): void {
    const { raw, handle } = this._host;
    raiseForCode(raw.swmm_events_remove(handle, this._index(idx)));
  }

  /** Insert an event at `idx` (the C API only appends, so the list is rebuilt). */
  insert(idx: number, value: EventInput): void {
    const events: EventInput[] = [...this];
    const n = events.length;
    const at = Math.max(0, Math.min(idx < 0 ? idx + n : idx, n));
    events.splice(at, 0, value);
    this.clear();
    for (const ev of events) this.append(ev);
  }

  /** Append an event. */
  append(value: EventInput): void {
    const { mod, raw, handle } = this._host;
    const [s, e] = unpack(value);
    withInt(mod, (p) => raw.swmm_events_add(handle, s, e, p));
  }

  /** Remove every event. */
  clear(): void {
    const { raw, handle } = this._host;
    raiseForCode(raw.swmm_events_clear(handle));
  }

  [Symbol.iterator](): Iterator<SimulationEvent> {
    const n = this.length;
    let i = 0;
    return {
      next: (): IteratorResult<SimulationEvent> =>
        i < n ? { value: this.get(i++), done: false } : { value: undefined, done: true },
    };
  }
}
