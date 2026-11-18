/**
 * @file SurfaceQuality.ts
 * @brief `surface2d.quality`: scoped 2D surface-quality authoring (coverages,
 *        initial loadings, curb lengths) and buildup snapshots (Python
 *        `openswmm.engine._surface_quality`).
 *
 * Edit before initialization. GLOBAL < TAG < CELL resolution applies to whole
 * coverage sets. Indices address cells.
 *
 * @license  Apache-2.0
 */

import { CellScope } from "./enums.js";
import { raiseForCode } from "./errors.js";
import { checkedAlloc, withCStrings, withInt } from "./mem.js";
import type { RawApi } from "./raw.js";
import type { OpenSwmmWasmModule } from "./types.js";

/** A whole land-use coverage set at one scope: `[landuse, percent]` pairs. */
export class SurfaceCoverage {
  constructor(
    readonly scope: CellScope,
    readonly tag: string,
    readonly cell: number,
    readonly landuses: readonly (readonly [string, number])[],
  ) {
    Object.freeze(this);
  }
}

/** Initial species buildup in project mass per acre/hectare. */
export class SurfaceLoading {
  constructor(
    readonly scope: CellScope,
    readonly tag: string,
    readonly cell: number,
    readonly species: string,
    readonly value: number,
  ) {
    Object.freeze(this);
  }
}

/** Authored curb length in project length units. */
export class SurfaceCurbLength {
  constructor(
    readonly scope: CellScope,
    readonly tag: string,
    readonly cell: number,
    readonly length: number,
  ) {
    Object.freeze(this);
  }
}

/** Where a row applies: a tag for TAG scope, a cell for CELL scope. */
export interface ScopeTarget {
  tag?: string;
  cell?: number;
}

function scopeOf(scope: CellScope | number): CellScope {
  if (!(scope in CellScope)) throw new RangeError(`${scope} is not a valid CellScope`);
  return scope;
}

/** `surface2d.quality`: coverages, loadings and curb lengths. */
export class SurfaceQuality {
  /** @internal Obtain through {@link Surface2D.quality}. */
  constructor(
    private readonly mod: OpenSwmmWasmModule,
    private readonly handle: number,
    private readonly raw: RawApi,
  ) {}

  /** @internal Allocate `bytes` of zeroed scratch, call `fn`, free. */
  private _scratch<T>(bytes: number, fn: (p: number) => T): T {
    const p = checkedAlloc(this.mod, bytes);
    try {
      this.mod.HEAPU8.fill(0, p, p + bytes);
      return fn(p);
    } finally {
      this.mod._free(p);
    }
  }

  /** Coverage sets; percentages sum to 100 or less. */
  get coverages(): SurfaceCoverage[] {
    const h = this.handle;
    const mod = this.mod;
    const count = withInt(mod, (p) => this.raw.swmm_2d_coverage_count(h, p));
    return this._scratch(16, (p) =>
      Array.from({ length: count }, (_, index) => {
        const pairs = withInt(mod, (q) => this.raw.swmm_2d_coverage_row_size(h, index, q));
        let tag = "";
        const uses: [string, number][] = [];
        for (let k = 0; k < pairs; k++) {
          const [t, landuse] = withCStrings(mod, 256, 2, ([tb, lb], len) =>
            this.raw.swmm_2d_coverage_get(h, index, k, p, tb, len, p + 4, lb, len, p + 8),
          );
          tag = t;
          uses.push([landuse, mod.HEAPF64[(p + 8) >> 3]]);
        }
        return new SurfaceCoverage(mod.HEAP32[p >> 2], tag, mod.HEAP32[(p + 4) >> 2], uses);
      }),
    );
  }

  /** Replace the whole coverage set at a scope from `landuse → percent`. */
  setCoverage(
    scope: CellScope | number,
    landuses: Readonly<Record<string, number>> | ReadonlyMap<string, number>,
    { tag = "", cell = -1 }: ScopeTarget = {},
  ): void {
    const items = landuses instanceof Map ? [...landuses] : Object.entries(landuses);
    if (!items.length) {
      throw new RangeError("Coverage needs at least one land use; remove the row to clear it");
    }
    if (items.some(([, v]) => !Number.isFinite(v))) {
      throw new RangeError("Coverage percentages must be finite");
    }
    const mod = this.mod;
    const n = items.length;
    const names: number[] = [];
    try {
      for (const [name] of items) {
        const bytes = mod.lengthBytesUTF8(name) + 1;
        const s = checkedAlloc(mod, bytes);
        mod.stringToUTF8(name, s, bytes);
        names.push(s);
      }
      // Name pointers, then the doubles from the next 8-byte boundary.
      this._scratch(16 * n, (p) => {
        mod.HEAPU32.set(names, p >> 2);
        const values = p + 4 * n + ((4 * n) % 8);
        mod.HEAPF64.set(
          items.map(([, v]) => v),
          values >> 3,
        );
        raiseForCode(
          this.raw.swmm_2d_coverage_set(this.handle, scopeOf(scope), tag, cell, p, values, n),
        );
      });
    } finally {
      for (const s of names) mod._free(s);
    }
  }

  /** Remove a coverage row; later indices shift. */
  removeCoverage(index: number): void {
    raiseForCode(this.raw.swmm_2d_coverage_remove(this.handle, index));
  }

  /** Initial buildup rows, in project mass per acre/hectare. */
  get loadings(): SurfaceLoading[] {
    const h = this.handle;
    const mod = this.mod;
    const count = withInt(mod, (p) => this.raw.swmm_2d_loading_count(h, p));
    return this._scratch(16, (p) =>
      Array.from({ length: count }, (_, index) => {
        const [tag, species] = withCStrings(mod, 256, 2, ([tb, sb], len) =>
          this.raw.swmm_2d_loading_get(h, index, p, tb, len, p + 4, sb, len, p + 8),
        );
        return new SurfaceLoading(
          mod.HEAP32[p >> 2],
          tag,
          mod.HEAP32[(p + 4) >> 2],
          species,
          mod.HEAPF64[(p + 8) >> 3],
        );
      }),
    );
  }

  /** Add or replace initial buildup at GLOBAL, TAG or CELL scope. */
  setLoading(
    scope: CellScope | number,
    species: string,
    value: number,
    { tag = "", cell = -1 }: ScopeTarget = {},
  ): void {
    raiseForCode(
      this.raw.swmm_2d_loading_set(this.handle, scopeOf(scope), tag, cell, species, value),
    );
  }

  removeLoading(index: number): void {
    raiseForCode(this.raw.swmm_2d_loading_remove(this.handle, index));
  }

  /** Curb-length rows in project length units. */
  get curbLengths(): SurfaceCurbLength[] {
    const h = this.handle;
    const mod = this.mod;
    const count = withInt(mod, (p) => this.raw.swmm_2d_curb_length_count(h, p));
    return this._scratch(16, (p) =>
      Array.from({ length: count }, (_, index) => {
        const [tag] = withCStrings(mod, 256, 1, ([tb], len) =>
          this.raw.swmm_2d_curb_length_get(h, index, p, tb, len, p + 4, p + 8),
        );
        return new SurfaceCurbLength(
          mod.HEAP32[p >> 2],
          tag,
          mod.HEAP32[(p + 4) >> 2],
          mod.HEAPF64[(p + 8) >> 3],
        );
      }),
    );
  }

  /** Add or replace a positive curb length at one scope. */
  setCurbLength(
    scope: CellScope | number,
    length: number,
    { tag = "", cell = -1 }: ScopeTarget = {},
  ): void {
    raiseForCode(this.raw.swmm_2d_curb_length_set(this.handle, scopeOf(scope), tag, cell, length));
  }

  removeCurbLength(index: number): void {
    raiseForCode(this.raw.swmm_2d_curb_length_remove(this.handle, index));
  }

  /**
   * Per-cell buildup of a species (project mass per acre/hectare). Needs an
   * active surface-quality store: {@link LifecycleError} before start.
   */
  buildup(species: string): Float64Array {
    const mod = this.mod;
    const n = withInt(mod, (p) => this.raw.swmm_2d_cell_count(this.handle, p));
    const p = checkedAlloc(mod, Math.max(8 * n, 8));
    try {
      raiseForCode(this.raw.swmm_2d_get_buildup_bulk(this.handle, species, p, n));
      return new Float64Array(mod.HEAPU8.buffer, p, n).slice();
    } finally {
      mod._free(p);
    }
  }
}
