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
 * @license  MIT
 */

import { raiseForCode } from "./errors.js";
import type { OpenSwmmWasmModule } from "./types.js";

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
  /** @internal */
  private readonly _engine: number;

  /** @internal */
  constructor(mod: OpenSwmmWasmModule, engine: number) {
    this._mod = mod;
    this._engine = engine;
  }

  // -------------------------------------------------------------------------
  // Collection interface
  // -------------------------------------------------------------------------

  /** Number of control rules defined in the model. */
  get length(): number {
    return this._mod.swmm_control_count(this._engine);
  }

  /**
   * Read the control rule at zero-based `index`.
   *
   * @throws {@link BadIndexError} if `index` is out of range.
   */
  get(index: number): ControlRule {
    const textBuf = this._mod._malloc(RULE_BUF_SIZE);
    const idBuf = this._mod._malloc(256);
    try {
      raiseForCode(
        this._mod.swmm_control_get_rule(this._engine, index, textBuf, RULE_BUF_SIZE),
      );
      raiseForCode(
        this._mod.swmm_control_get_id(this._engine, index, idBuf, 256),
      );
      return {
        id: this._mod.UTF8ToString(idBuf),
        text: this._mod.UTF8ToString(textBuf),
      };
    } finally {
      this._mod._free(textBuf);
      this._mod._free(idBuf);
    }
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
    raiseForCode(this._mod.swmm_control_add_rule(this._engine, ruleText));
  }

  /**
   * Remove the rule at zero-based `index`.
   *
   * @throws {@link BadIndexError} if `index` is out of range.
   */
  removeRule(index: number): void {
    raiseForCode(this._mod.swmm_control_remove_rule(this._engine, index));
  }

  /**
   * Remove all control rules from the model.
   */
  clearRules(): void {
    raiseForCode(this._mod.swmm_control_clear_rules(this._engine));
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
    raiseForCode(this._mod.swmm_control_set_link_setting(this._engine, linkIdx, setting));
  }

  /**
   * Open (`status = 1`) or close (`status = 0`) a pump.
   *
   * @param linkIdx  Zero-based link index.
   * @param status   1 = on / open, 0 = off / closed.
   */
  setLinkStatus(linkIdx: number, status: number): void {
    raiseForCode(this._mod.swmm_control_set_link_status(this._engine, linkIdx, status));
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
