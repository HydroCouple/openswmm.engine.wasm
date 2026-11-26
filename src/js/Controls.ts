/**
 * @file Controls.ts
 * @brief Control rules collection for the OpenSWMM WASM bindings.
 *
 * @details Mirrors the Python `_controls.pyi` binding specification.
 * Control rules are SWMM's rule-based real-time control system (the
 * `[RULES]` section of the .inp file).
 *
 * @author   Caleb Buahin <caleb.buahin@gmail.com>
 * @copyright Copyright (c) 2026 Caleb Buahin. All rights reserved.
 * @license  Apache-2.0
 */

import { ElementNotFoundError, raiseForCode } from "./errors.js";
import type { OpenSwmmWasmModule } from "./types.js";
import type { RawApi } from "./raw.js";
import { checkedAlloc, guardedRaw, withCString } from "./mem.js";

// Maximum buffer size for reading rule text from the engine.
const RULE_BUF_SIZE = 4096;

// =============================================================================
// ControlRule
// =============================================================================

/**
 * A single SWMM rule-based control rule.
 */
export interface ControlRule {
  /** The unique rule identifier (first token of the RULE line). */
  readonly id: string;
  /** Full rule text as it would appear in the `[RULES]` section. */
  readonly text: string;
}

// =============================================================================
// Controls
// =============================================================================

/**
 * Mutable sequence of SWMM control rules.
 *
 * Obtain via {@link Solver.controls}.
 *
 * @example
 * ```ts
 * const controls = solver.controls;
 * console.log(controls.length);
 *
 * // Read a rule
 * const rule = controls.get(0);
 * console.log(rule.id, rule.text);
 *
 * // Add a rule (OPENED or BUILDING state)
 * controls.addRule(
 *   "RULE PUMP_ON\nIF NODE J1 DEPTH > 1.0\nTHEN LINK P1 STATUS = OPEN\n"
 * );
 *
 * // Directly control a link at runtime
 * const linkIdx = solver.links.getIndex("P1");
 * controls.setLinkSetting(linkIdx, 1.0);
 *
 * // Remove all rules
 * controls.clearRules();
 * ```
 */
export class Controls implements Iterable<ControlRule> {
  /** @internal */
  private readonly _mod: OpenSwmmWasmModule;
  private readonly _raw: RawApi;
  /** @internal */
  private readonly _engine: number;

  /** @internal */
  constructor(
    mod: OpenSwmmWasmModule,
    engine: number,
    private readonly _checkOwner: () => void = () => {},
  ) {
    this._mod = mod;
    this._raw = guardedRaw(mod, this._checkOwner);
    this._engine = engine;
  }

  // -------------------------------------------------------------------------
  // Collection interface
  // -------------------------------------------------------------------------

  /** Number of control rules defined in the model. */
  get length(): number {
    return this._raw.swmm_control_count(this._engine);
  }

  /**
   * Read the control rule at zero-based `index`.
   *
   * @throws {@link BadIndexError} if `index` is out of range.
   */
  get(index: number): ControlRule {
    index = this._index(index);
    const text = withCString(this._mod, RULE_BUF_SIZE, (buf, len) =>
      this._raw.swmm_control_get_rule(this._engine, index, buf, len),
    );
    const id = withCString(this._mod, 256, (buf, len) =>
      this._raw.swmm_control_get_id(this._engine, index, buf, len),
    );
    return { id, text };
  }

  // -------------------------------------------------------------------------
  // Mutation
  // -------------------------------------------------------------------------

  /**
   * Add a new control rule from a multi-line rule text string.
   *
   * @param ruleText Full rule text (same syntax as `[RULES]` section).
   * @throws {@link LifecycleError} if the engine is in an incompatible state.
   */
  addRule(ruleText: string): void {
    raiseForCode(this._raw.swmm_control_add_rule(this._engine, ruleText));
  }

  /**
   * Remove the rule at zero-based `index`.
   *
   * @throws {@link BadIndexError} if `index` is out of range.
   */
  removeRule(index: number): void {
    raiseForCode(this._raw.swmm_control_remove_rule(this._engine, index));
  }

  /**
   * Remove all control rules from the model.
   */
  clearRules(): void {
    raiseForCode(this._raw.swmm_control_clear_rules(this._engine));
  }

  /** @internal Normalize a (possibly negative) index. @throws ElementNotFoundError */
  private _index(index: number): number {
    const n = this.length;
    const i = index < 0 ? index + n : index;
    if (!Number.isInteger(i) || i < 0 || i >= n) throw new ElementNotFoundError(index);
    return i;
  }

  /** Replace the rule at `index` (the C API only appends, so the list is rebuilt). */
  set(index: number, value: string | ControlRule): void {
    const rules = [...this].map((r) => r.text);
    rules[this._index(index)] = ruleText(value);
    this.clear();
    for (const r of rules) this.append(r);
  }

  /** Remove the rule at `index` (negative counts from the end). */
  delete(index: number): void {
    raiseForCode(this._raw.swmm_control_remove_rule(this._engine, this._index(index)));
  }

  /** Insert a rule at `index` (the list is rebuilt). */
  insert(index: number, value: string | ControlRule): void {
    const rules = [...this].map((r) => r.text);
    const n = rules.length;
    rules.splice(Math.max(0, Math.min(index < 0 ? index + n : index, n)), 0, ruleText(value));
    this.clear();
    for (const r of rules) this.append(r);
  }

  /** Append a rule. */
  append(value: string | ControlRule): void {
    raiseForCode(this._raw.swmm_control_add_rule(this._engine, ruleText(value)));
  }

  /** Remove every rule. */
  clear(): void {
    raiseForCode(this._raw.swmm_control_clear_rules(this._engine));
  }

  /**
   * Replace the whole control program at once from rule blocks; with
   * `publish: false` only validate it. Throws the engine's error, with its
   * message, when a block is invalid; the program is unchanged then.
   */
  replaceProgram(blocks: Iterable<string | ControlRule>, { publish = true } = {}): void {
    const texts = Array.from(blocks, ruleText);
    if (texts.some((s) => s.includes("\0")))
      throw new RangeError("Control blocks must not contain NUL");
    const mod = this._mod;
    const strings = texts.map((s) => {
      const bytes = mod.lengthBytesUTF8(s) + 1;
      const ptr = checkedAlloc(mod, bytes);
      mod.stringToUTF8(s, ptr, bytes);
      return ptr;
    });
    const table = checkedAlloc(mod, 4 * Math.max(texts.length, 1));
    try {
      strings.forEach((ptr, i) => (mod.HEAPU32[(table >> 2) + i] = ptr));
      for (let capacity = 256; ; capacity *= 2) {
        const error = checkedAlloc(mod, capacity);
        try {
          mod.HEAPU8[error] = 0;
          const rc = this._raw.swmm_control_replace_program(
            this._engine,
            texts.length ? table : 0,
            texts.length,
            publish ? 1 : 0,
            error,
            capacity,
          );
          const message = mod.UTF8ToString(error, capacity);
          if (rc && mod.lengthBytesUTF8(message) >= capacity - 1) continue;
          if (rc) raiseForCode(rc, message);
          return;
        } finally {
          mod._free(error);
        }
      }
    } finally {
      mod._free(table);
      for (const ptr of strings) mod._free(ptr);
    }
  }

  /** Indices of the rules that mention an object (node, link, ...) by name. */
  findReferences(objectName: string): number[] {
    const mod = this._mod;
    const count = checkedAlloc(mod, 4);
    try {
      mod.HEAP32[count >> 2] = 0;
      raiseForCode(this._raw.swmm_control_find_references(this._engine, objectName, 0, count));
      const n = mod.HEAP32[count >> 2];
      if (n <= 0) return [];
      const buf = checkedAlloc(mod, 4 * n);
      try {
        raiseForCode(this._raw.swmm_control_find_references(this._engine, objectName, buf, count));
        return Array.from(mod.HEAP32.subarray(buf >> 2, (buf >> 2) + mod.HEAP32[count >> 2]));
      } finally {
        mod._free(buf);
      }
    } finally {
      mod._free(count);
    }
  }

  /** Check rule text without adding it: `[ok, message]`. */
  validateMessage(ruleText: string): [boolean, string] {
    const mod = this._mod;
    const buf = checkedAlloc(mod, 1024 + 4);
    try {
      mod.HEAPU8[buf] = 0;
      const rc = this._raw.swmm_control_validate_rule(
        this._engine,
        ruleText,
        buf,
        1024,
        buf + 1024,
      );
      return [rc === 0, mod.UTF8ToString(buf, 1024)];
    } finally {
      mod._free(buf);
    }
  }

  // -------------------------------------------------------------------------
  // Real-time control helpers
  // -------------------------------------------------------------------------

  /**
   * Override the opening fraction of a link (e.g. orifice/weir gate position).
   *
   * @param linkIdx  Zero-based link index (use `solver.links.getIndex(id)`).
   * @param setting  Opening fraction in [0, 1].
   */
  setLinkSetting(linkIdx: number, setting: number): void {
    raiseForCode(this._raw.swmm_control_set_link_setting(this._engine, linkIdx, setting));
  }

  /**
   * Open (`status = 1`) or close (`status = 0`) a pump.
   *
   * @param linkIdx  Zero-based link index.
   * @param status   1 = on / open, 0 = off / closed.
   */
  setLinkStatus(linkIdx: number, status: number): void {
    raiseForCode(this._raw.swmm_control_set_link_status(this._engine, linkIdx, status));
  }

  // -------------------------------------------------------------------------
  // Iteration
  // -------------------------------------------------------------------------

  [Symbol.iterator](): Iterator<ControlRule> {
    let i = 0;
    const length = this.length;
    return {
      next: (): IteratorResult<ControlRule> => {
        if (i < length) {
          return { value: this.get(i++), done: false };
        }
        return { value: undefined as unknown as ControlRule, done: true };
      },
    };
  }
}

/** Rule text of a string or a {@link ControlRule}. */
function ruleText(value: string | ControlRule): string {
  return typeof value === "string" ? value : value.text;
}
