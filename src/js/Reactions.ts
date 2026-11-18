/**
 * @file Reactions.ts
 * @brief `solver.reactions`: the `[REACTION_*]` / `.rxn` multi-species
 *        reaction system (Python `openswmm.engine._reactions`).
 *
 * Species, coefficients and terms, per-species PIPE/TANK expressions,
 * initial quality, `[REACTION_OPTIONS]` and the whole-file text round trip
 * (`serialize` → `applyText` → `serialize` is byte-identical). Every
 * mutation recompiles the whole system first: one that would leave any
 * expression uncompilable is rolled back and refused with
 * {@link BadParamError}. Edits are BUILDING/OPENED only. Names resolve by an
 * exact, case-sensitive scan (the C API has no name index here).
 *
 * @license  Apache-2.0
 */

import { ReactionExprForm, ReactionScope } from "./enums.js";
import { ElementNotFoundError, raiseForCode } from "./errors.js";
import { checkedAlloc, rawOf, withCString, withCStrings, withDouble } from "./mem.js";
import type { OpenSwmmWasmModule } from "./types.js";
import type { Solver } from "./Solver.js";
import { SolverView } from "./view.js";

/** A built-in hydraulic variable usable in expressions. */
export interface ReactionHydVar {
  readonly name: string;
  readonly description: string;
}

/** A built-in math function usable in expressions. */
export interface ReactionFunction {
  readonly name: string;
  readonly arity: number;
}

/** One NODE/LINK initial-quality row. */
export interface ReactionInitialEntry {
  readonly isLink: boolean;
  readonly elemIndex: number;
  readonly speciesIndex: number;
  readonly value: number;
}

/** Result of a compile-only check; `column` is 1-based, -1 when not attributable. */
export interface ExpressionDiagnostic {
  readonly valid: boolean;
  readonly message: string;
  readonly column: number;
}

/** @internal Read `n` numeric outputs after a string-reading call. */
function rowRead<T>(
  mod: OpenSwmmWasmModule,
  strings: number,
  call: (bufs: number[], len: number, out: number) => number,
  take: (texts: string[], out: number) => T,
): T {
  const out = checkedAlloc(mod, 32);
  try {
    mod.HEAPU8.fill(0, out, out + 32);
    const texts = withCStrings(mod, 256, strings, (bufs, len) => call(bufs, len, out));
    return take(texts, out);
  } finally {
    mod._free(out);
  }
}

function speciesRowOf(solver: Solver, idx: number): [string, boolean, string, number, number] {
  const mod = solver.module;
  const raw = rawOf(mod);
  return rowRead(
    mod,
    2,
    ([name, units], len, o) =>
      raw.swmm_reaction_species_get(solver.handle, idx, name, len, o, units, len, o + 8, o + 16),
    ([name, units], o) => [
      name,
      mod.HEAP32[o >> 2] !== 0,
      units,
      mod.HEAPF64[(o + 8) >> 3],
      mod.HEAPF64[(o + 16) >> 3],
    ],
  );
}

function coeffRowOf(solver: Solver, idx: number): [string, boolean, number] {
  const mod = solver.module;
  const raw = rawOf(mod);
  return rowRead(
    mod,
    1,
    ([name], len, o) => raw.swmm_reaction_coeff_get(solver.handle, idx, name, len, o, o + 8),
    ([name], o) => [name, mod.HEAP32[o >> 2] !== 0, mod.HEAPF64[(o + 8) >> 3]],
  );
}

function termRowOf(solver: Solver, idx: number): [string, string] {
  const raw = rawOf(solver.module);
  const [name, expr] = withCStrings(solver.module, 256, 2, ([n, e], len) =>
    raw.swmm_reaction_term_get(solver.handle, idx, n, len, e, len),
  );
  return [name, expr];
}

/** Python `_resolve_row`: an index (negative counts from the end) or an exact name. */
function resolveRow(
  key: number | string,
  count: number,
  nameAt: (i: number) => string,
  label: string,
): number {
  if (typeof key === "string") {
    for (let i = 0; i < count; i++) if (nameAt(i) === key) return i;
    throw new ElementNotFoundError(key, `${label} '${key}' not found`);
  }
  if (typeof key !== "number" || !Number.isInteger(key)) {
    throw new TypeError(`${label} key must be an int index or a str name, got ${typeof key}`);
  }
  const i = key < 0 ? key + count : key;
  if (!(i >= 0 && i < count)) throw new RangeError(`${label} index out of range: ${key}`);
  return i;
}

/** One declared species: a live view over its index (re-look-up after structural edits). */
export class ReactionSpecies extends SolverView {
  /** @internal */
  constructor(
    solver: Solver,
    readonly index: number,
  ) {
    super(solver);
  }

  get name(): string {
    return speciesRowOf(this._solver, this.index)[0];
  }

  /** True for a WALL species, false for BULK. */
  get isWall(): boolean {
    return speciesRowOf(this._solver, this.index)[1];
  }

  /** Concentration units token (`"MG"`, `"UG"`, `"#"`). */
  get units(): string {
    return speciesRowOf(this._solver, this.index)[2];
  }

  /** Absolute tolerance; 0 uses the global ATOL. */
  get atol(): number {
    return speciesRowOf(this._solver, this.index)[3];
  }

  /** Relative tolerance; 0 uses the global RTOL. */
  get rtol(): number {
    return speciesRowOf(this._solver, this.index)[4];
  }

  /** `[form, expression]` in one scope (`NONE` and `""` when absent). */
  getExpression(scope: ReactionScope): [ReactionExprForm, string] {
    return rowRead(
      this._mod,
      1,
      ([e], len, o) => this._raw.swmm_reaction_expr_get(this._h, scope, this.index, o, e, len),
      ([e], o) => [this._mod.HEAP32[o >> 2] as ReactionExprForm, e],
    );
  }

  /** Set (or with `NONE` clear) one scope's expression; rolled back if it does not compile. */
  setExpression(scope: ReactionScope, form: ReactionExprForm, expression = ""): void {
    raiseForCode(this._raw.swmm_reaction_expr_set(this._h, scope, this.index, form, expression));
  }

  /** `[form, expression]` of the conduit scope. */
  get pipeExpression(): [ReactionExprForm, string] {
    return this.getExpression(ReactionScope.PIPE);
  }

  /** `[form, expression]` of the storage-unit scope. */
  get tankExpression(): [ReactionExprForm, string] {
    return this.getExpression(ReactionScope.TANK);
  }

  /** Model-wide initial concentration in species units (overrides: `reactions.initial`). */
  get initial(): number {
    return withDouble(this._mod, (p) =>
      this._raw.swmm_reaction_init_global_get(this._h, this.index, p),
    );
  }
  set initial(value: number) {
    raiseForCode(this._raw.swmm_reaction_init_global_set(this._h, this.index, value));
  }

  /** `[REACTION_RAINFALL]` concentration; 0 is clean rainfall. */
  get rainConc(): number {
    return withDouble(this._mod, (p) =>
      this._raw.swmm_reaction_rain_conc_get(this._h, this.index, p),
    );
  }
  set rainConc(value: number) {
    raiseForCode(this._raw.swmm_reaction_rain_conc_set(this._h, this.index, value));
  }
}

/** One `[REACTION_COEFFICIENTS]` entry (CONSTANT or PARAMETER): a live view. */
export class ReactionCoefficient extends SolverView {
  /** @internal */
  constructor(
    solver: Solver,
    readonly index: number,
  ) {
    super(solver);
  }

  get name(): string {
    return coeffRowOf(this._solver, this.index)[0];
  }

  /** True for a PARAMETER (pipe/tank-overridable), false for a CONSTANT. */
  get isParam(): boolean {
    return coeffRowOf(this._solver, this.index)[1];
  }

  get value(): number {
    return coeffRowOf(this._solver, this.index)[2];
  }
  set value(v: number) {
    raiseForCode(this._raw.swmm_reaction_coeff_set_value(this._h, this.index, v));
  }
}

/** One `[REACTION_TERMS]` entry, a named intermediate expression: a live view. */
export class ReactionTerm extends SolverView {
  /** @internal */
  constructor(
    solver: Solver,
    readonly index: number,
  ) {
    super(solver);
  }

  get name(): string {
    return termRowOf(this._solver, this.index)[0];
  }

  get expression(): string {
    return termRowOf(this._solver, this.index)[1];
  }
  set expression(expr: string) {
    raiseForCode(this._raw.swmm_reaction_term_set_expr(this._h, this.index, expr));
  }
}

/** `reactions.species` (Python `_SpeciesCollection`). */
export class SpeciesCollection extends SolverView {
  get length(): number {
    return this._raw.swmm_reaction_species_count(this._h);
  }

  *[Symbol.iterator](): Iterator<ReactionSpecies> {
    const n = this.length;
    for (let i = 0; i < n; i++) yield new ReactionSpecies(this._solver, i);
  }

  get(key: number | string): ReactionSpecies {
    return new ReactionSpecies(this._solver, this.getIndex(key));
  }

  has(key: number | string): boolean {
    try {
      this.getIndex(key);
      return true;
    } catch {
      return false;
    }
  }

  getIndex(key: number | string): number {
    return resolveRow(
      key,
      this.length,
      (i) => speciesRowOf(this._solver, i)[0],
      "Reaction species",
    );
  }

  /** Declare a species (BUILDING/OPENED); rolled back if anything stops compiling. */
  add(
    name: string,
    {
      wall = false,
      units = "",
      atol = 0,
      rtol = 0,
    }: { wall?: boolean; units?: string; atol?: number; rtol?: number } = {},
  ): ReactionSpecies {
    raiseForCode(
      this._raw.swmm_reaction_species_add(this._h, name, wall ? 1 : 0, units, atol, rtol),
    );
    this._solver._bumpGeneration();
    return new ReactionSpecies(this._solver, this.length - 1);
  }

  /** Remove a species (refused while referenced); later species shift down. */
  remove(key: number | string): void {
    raiseForCode(this._raw.swmm_reaction_species_remove(this._h, this.getIndex(key)));
    this._solver._bumpGeneration();
  }
}

/** `reactions.coefficients` (Python `_CoefficientCollection`). */
export class CoefficientCollection extends SolverView {
  get length(): number {
    return this._raw.swmm_reaction_coeff_count(this._h);
  }

  *[Symbol.iterator](): Iterator<ReactionCoefficient> {
    const n = this.length;
    for (let i = 0; i < n; i++) yield new ReactionCoefficient(this._solver, i);
  }

  get(key: number | string): ReactionCoefficient {
    return new ReactionCoefficient(this._solver, this.getIndex(key));
  }

  has(key: number | string): boolean {
    try {
      this.getIndex(key);
      return true;
    } catch {
      return false;
    }
  }

  getIndex(key: number | string): number {
    return resolveRow(
      key,
      this.length,
      (i) => coeffRowOf(this._solver, i)[0],
      "Reaction coefficient",
    );
  }

  /** Add a coefficient; `parameter` makes it pipe/tank-overridable. */
  add(
    name: string,
    { parameter = false, value = 0 }: { parameter?: boolean; value?: number } = {},
  ): ReactionCoefficient {
    raiseForCode(this._raw.swmm_reaction_coeff_add(this._h, name, parameter ? 1 : 0, value));
    this._solver._bumpGeneration();
    return new ReactionCoefficient(this._solver, this.length - 1);
  }

  /** Remove a coefficient (refused while referenced); later ones shift down. */
  remove(key: number | string): void {
    raiseForCode(this._raw.swmm_reaction_coeff_remove(this._h, this.getIndex(key)));
    this._solver._bumpGeneration();
  }
}

/** `reactions.terms`, ordered (Python `_TermCollection`). */
export class TermCollection extends SolverView {
  get length(): number {
    return this._raw.swmm_reaction_term_count(this._h);
  }

  *[Symbol.iterator](): Iterator<ReactionTerm> {
    const n = this.length;
    for (let i = 0; i < n; i++) yield new ReactionTerm(this._solver, i);
  }

  get(key: number | string): ReactionTerm {
    return new ReactionTerm(this._solver, this.getIndex(key));
  }

  has(key: number | string): boolean {
    try {
      this.getIndex(key);
      return true;
    } catch {
      return false;
    }
  }

  getIndex(key: number | string): number {
    return resolveRow(key, this.length, (i) => termRowOf(this._solver, i)[0], "Reaction term");
  }

  /** Append a term; it may reference every term declared before it. */
  add(name: string, expr: string): ReactionTerm {
    raiseForCode(this._raw.swmm_reaction_term_add(this._h, name, expr));
    this._solver._bumpGeneration();
    return new ReactionTerm(this._solver, this.length - 1);
  }

  /** Remove a term (refused while referenced); later terms shift down. */
  remove(key: number | string): void {
    raiseForCode(this._raw.swmm_reaction_term_remove(this._h, this.getIndex(key)));
    this._solver._bumpGeneration();
  }
}

/** `reactions.initial`: per-node/per-link initial quality rows (Python `_InitialQualityRows`). */
export class InitialQualityRows extends SolverView {
  get length(): number {
    return this._raw.swmm_reaction_init_elem_count(this._h);
  }

  *[Symbol.iterator](): Iterator<ReactionInitialEntry> {
    const n = this.length;
    for (let i = 0; i < n; i++) yield this.get(i);
  }

  /** @internal */
  private _row(row: number): number {
    const n = this.length;
    const i = row < 0 ? row + n : row;
    if (!(i >= 0 && i < n)) throw new RangeError(`Initial-quality row index out of range: ${row}`);
    return i;
  }

  get(row: number): ReactionInitialEntry {
    const i = this._row(row);
    const mod = this._mod;
    const p = checkedAlloc(mod, 24);
    try {
      mod.HEAPU8.fill(0, p, p + 24);
      raiseForCode(this._raw.swmm_reaction_init_elem_get(this._h, i, p, p + 4, p + 8, p + 16));
      return {
        isLink: mod.HEAP32[p >> 2] !== 0,
        elemIndex: mod.HEAP32[(p + 4) >> 2],
        speciesIndex: mod.HEAP32[(p + 8) >> 2],
        value: mod.HEAPF64[(p + 16) >> 3],
      };
    } finally {
      mod._free(p);
    }
  }

  /** Add or update the row keyed by `(isLink, elemIndex, species)`. */
  set(isLink: boolean, elemIndex: number, species: number | string, value: number): void {
    const sp = resolveRow(
      species,
      this._raw.swmm_reaction_species_count(this._h),
      (i) => speciesRowOf(this._solver, i)[0],
      "Reaction species",
    );
    raiseForCode(
      this._raw.swmm_reaction_init_elem_set(this._h, isLink ? 1 : 0, elemIndex, sp, value),
    );
  }

  /** Remove a row; later rows shift down. */
  remove(row: number): void {
    raiseForCode(this._raw.swmm_reaction_init_elem_remove(this._h, this._row(row)));
  }
}

/** `solver.reactions`: the `[REACTION_*]` / `.rxn` surface. */
export class Reactions extends SolverView {
  private _species?: SpeciesCollection;
  private _coefficients?: CoefficientCollection;
  private _terms?: TermCollection;
  private _initial?: InitialQualityRows;

  get species(): SpeciesCollection {
    return (this._species ??= new SpeciesCollection(this._solver));
  }

  get coefficients(): CoefficientCollection {
    return (this._coefficients ??= new CoefficientCollection(this._solver));
  }

  get terms(): TermCollection {
    return (this._terms ??= new TermCollection(this._solver));
  }

  get initial(): InitialQualityRows {
    return (this._initial ??= new InitialQualityRows(this._solver));
  }

  /**
   * Compile-only check of one expression against the live vocabulary; never
   * changes state. In TERM scope every term is accepted (ordering is checked
   * when a whole file is applied).
   */
  validate(expr: string, scope: ReactionScope = ReactionScope.PIPE): ExpressionDiagnostic {
    const mod = this._mod;
    const p = checkedAlloc(mod, 512 + 4);
    try {
      mod.HEAPU8[p] = 0;
      mod.HEAP32[(p + 512) >> 2] = -1;
      const rc = this._raw.swmm_reaction_validate_expression(this._h, scope, expr, p, 512, p + 512);
      if (rc === 0) return { valid: true, message: "", column: -1 };
      return {
        valid: false,
        message: mod.UTF8ToString(p, 512),
        column: mod.HEAP32[(p + 512) >> 2],
      };
    } finally {
      mod._free(p);
    }
  }

  /** One `[REACTION_OPTIONS]` value as its canonical token. */
  getOption(key: string): string {
    return withCString(this._mod, 256, (buf, len) =>
      this._raw.swmm_reaction_option_get(this._h, key, buf, len),
    );
  }

  /** Set one `[REACTION_OPTIONS]` value (validated with rollback). */
  setOption(key: string, value: string): void {
    raiseForCode(this._raw.swmm_reaction_option_set(this._h, key, value));
  }

  /** The canonical `.rxn` text (`""` when no reaction system is configured). */
  serialize(): string {
    const mod = this._mod;
    const need = checkedAlloc(mod, 4);
    try {
      mod.HEAP32[need >> 2] = 0;
      const rc = this._raw.swmm_reactions_serialize(this._h, 0, 0, need);
      const n = mod.HEAP32[need >> 2];
      if (n <= 0) {
        raiseForCode(rc);
        return "";
      }
      const buf = checkedAlloc(mod, n);
      try {
        raiseForCode(this._raw.swmm_reactions_serialize(this._h, buf, n, need));
        return mod.UTF8ToString(buf, n);
      } finally {
        mod._free(buf);
      }
    } finally {
      mod._free(need);
    }
  }

  /** Dry-run a whole `.rxn` file; never changes state (column is always -1). */
  checkText(text: string): ExpressionDiagnostic {
    return this._textCall(text, this._raw.swmm_reactions_check_text, false);
  }

  /**
   * Replace the whole reaction system from `.rxn` text, all or nothing: on
   * any error the previous system is unchanged and the engine's diagnostic
   * is thrown. Invalidates species, coefficient, term and row views.
   */
  applyText(text: string): void {
    this._textCall(text, this._raw.swmm_reactions_apply_text, true);
    this._solver._bumpGeneration();
  }

  /** @internal */
  private _textCall(
    text: string,
    fn: (h: number, text: string, err: number, len: number) => number,
    raise: boolean,
  ): ExpressionDiagnostic {
    const mod = this._mod;
    const p = checkedAlloc(mod, 512);
    try {
      mod.HEAPU8[p] = 0;
      const rc = fn(this._h, text, p, 512);
      if (rc === 0) return { valid: true, message: "", column: -1 };
      const message = mod.UTF8ToString(p, 512);
      if (raise) raiseForCode(rc, message);
      return { valid: false, message, column: -1 };
    } finally {
      mod._free(p);
    }
  }

  /** Write the `.rxn` file to `path`, or to the reaction component's bound config path. */
  save(path: string | null = null): void {
    raiseForCode(this._raw.swmm_reactions_save(this._h, path));
  }

  /** Every built-in hydraulic variable (no model needed). */
  static hydraulicVariables(mod: OpenSwmmWasmModule): ReactionHydVar[] {
    const raw = rawOf(mod);
    return Array.from({ length: raw.swmm_reaction_hydvar_count() }, (_, i) => {
      const [name, description] = withCStrings(mod, 256, 2, ([n, d], len) =>
        raw.swmm_reaction_hydvar_get(i, n, len, d, len),
      );
      return { name, description };
    });
  }

  /** Every built-in math function with its arity (no model needed). */
  static functions(mod: OpenSwmmWasmModule): ReactionFunction[] {
    const raw = rawOf(mod);
    const p = checkedAlloc(mod, 4);
    try {
      return Array.from({ length: raw.swmm_reaction_function_count() }, (_, i) => {
        mod.HEAP32[p >> 2] = 0;
        const [name] = withCStrings(mod, 128, 1, ([n], len) =>
          raw.swmm_reaction_function_get(i, n, len, p),
        );
        return { name, arity: mod.HEAP32[p >> 2] };
      });
    } finally {
      mod._free(p);
    }
  }
}
