/**
 * @file Snow2D.ts
 * @brief `surface2d.snow`: mesh snow configuration and accepted SI cell
 *        snapshots (Python `openswmm.engine._snow2d`).
 *
 * Records keep the engine's field names (`swe_m`, `completed_s`, ...), as
 * {@link Snow} does for subcatchment snow.
 *
 * @license  Apache-2.0
 */

import { ErrorCode } from "./enums.js";
import { raiseForCode } from "./errors.js";
import { checkedAlloc, withInt } from "./mem.js";
import { STRUCTS, type RawApi } from "./raw.js";
import type { SnowRecord } from "./Snow.js";
import { readStruct } from "./structs.js";
import type { OpenSwmmWasmModule } from "./types.js";

const SECTIONS = ["options", "defaults", "cells"] as const;
const MODES = ["AUTO", "YES", "NO"] as const;

/** One authored mesh snow row; NaN overrides inherit, cells are zero based. */
export interface MeshSnowRow {
  cell: number;
  tag: string;
  pack: string;
  forest: number;
  drift: number;
  ground_heat_wm2: number;
  extinction_depth_m: number;
  slope_deg: number;
  aspect_deg: number;
}

/** Mesh snow assignments and accepted cell snapshots. */
export class MeshSnow {
  /** @internal Obtain through {@link Surface2D.snow}. */
  constructor(
    private readonly mod: OpenSwmmWasmModule,
    private readonly handle: number,
    private readonly raw: RawApi,
  ) {}

  /** The three section bodies as text. */
  configuration(): { options: string; defaults: string; cells: string } {
    const mod = this.mod;
    const out = {} as Record<(typeof SECTIONS)[number], string>;
    SECTIONS.forEach((name, section) => {
      const size = withInt(mod, (p) =>
        this.raw.swmm_snow2d_get_configuration(this.handle, section, 0, 0, p),
      );
      const buf = checkedAlloc(mod, Math.max(size, 1));
      const req = checkedAlloc(mod, 4);
      try {
        mod.HEAPU8[buf] = 0;
        raiseForCode(this.raw.swmm_snow2d_get_configuration(this.handle, section, buf, size, req));
        out[name] = mod.UTF8ToString(buf, size);
      } finally {
        mod._free(buf);
        mod._free(req);
      }
    });
    return out;
  }

  /**
   * Replace all three section bodies at once (named packs are kept).
   *
   * @throws RangeError with the engine's diagnostic when a body is invalid.
   */
  applyConfiguration(options = "", defaults = "", cells = ""): void {
    const mod = this.mod;
    const diag = checkedAlloc(mod, 4096);
    try {
      mod.HEAPU8[diag] = 0;
      const code = this.raw.swmm_snow2d_apply_configuration(
        this.handle,
        options,
        defaults,
        cells,
        diag,
        4096,
      );
      if (code) {
        const text = mod.UTF8ToString(diag, 4096);
        if (text) throw new RangeError(text);
        raiseForCode(code);
      }
    } finally {
      mod._free(diag);
    }
  }

  /** @internal */
  private _cells(): number {
    return withInt(this.mod, (p) => this.raw.swmm_2d_cell_count(this.handle, p));
  }

  /** Accepted snow state of every cell. */
  states(): SnowRecord[] {
    const n = this._cells();
    if (!n) return [];
    const size = STRUCTS.SWMM_SnowState.size;
    const p = checkedAlloc(this.mod, n * size);
    try {
      raiseForCode(this.raw.swmm_snow2d_get_states(this.handle, 0, n, p));
      return Array.from(
        { length: n },
        (_, i) => readStruct(this.mod, "SWMM_SnowState", p + i * size) as SnowRecord,
      );
    } finally {
      this.mod._free(p);
    }
  }

  /** Water and energy ledgers of every cell, with `geometry_energy_kj`. */
  ledgers(): SnowRecord[] {
    const n = this._cells();
    if (!n) return [];
    const size = STRUCTS.SWMM_MeshSnowLedger.size;
    const mod = this.mod;
    const p = checkedAlloc(mod, n * size);
    const g = checkedAlloc(mod, 8 * n);
    try {
      raiseForCode(this.raw.swmm_snow2d_get_ledgers(this.handle, 0, n, p));
      raiseForCode(this.raw.swmm_snow2d_get_geometry_energy(this.handle, 0, n, g));
      return Array.from({ length: n }, (_, i) => ({
        ...(readStruct(mod, "SWMM_MeshSnowLedger", p + i * size) as SnowRecord),
        geometry_energy_kj: mod.HEAPF64[(g >> 3) + i],
      }));
    } finally {
      mod._free(p);
      mod._free(g);
    }
  }

  /** Mode AUTO/YES/NO and step in seconds (zero inherits the shared step). */
  get options(): { mode: (typeof MODES)[number]; step_seconds: number } {
    const mod = this.mod;
    const p = checkedAlloc(mod, 16);
    try {
      mod.HEAP32[p >> 2] = 0;
      mod.HEAPF64[(p + 8) >> 3] = 0;
      raiseForCode(this.raw.swmm_snow2d_get_options(this.handle, p, p + 8));
      return { mode: MODES[mod.HEAP32[p >> 2]], step_seconds: mod.HEAPF64[(p + 8) >> 3] };
    } finally {
      mod._free(p);
    }
  }

  /** Authored `defaults` or `cells` rows. */
  rows(section: "defaults" | "cells" = "defaults"): MeshSnowRow[] {
    const which = { defaults: 1, cells: 2 }[section];
    if (!which) throw new RangeError("section must be defaults or cells");
    const mod = this.mod;
    const h = this.handle;
    const count =
      which === 1 ? this.raw.swmm_snow2d_defaults_count(h) : this.raw.swmm_snow2d_cells_count(h);
    const overrides = STRUCTS.SWMM_MeshSnowOverrides.size;
    const rows: MeshSnowRow[] = [];
    for (let i = 0; i < count; i++) {
      for (let size = 256; ; size *= 2) {
        const p = checkedAlloc(mod, 8 + overrides + 2 * size);
        try {
          const cell = p;
          const values = p + 8;
          const tag = values + overrides;
          const pack = tag + size;
          mod.HEAPU8.fill(0, p, p + 8 + overrides + 2 * size);
          const rc = this.raw.swmm_snow2d_get_row(h, which, i, cell, tag, size, pack, size, values);
          if (rc === ErrorCode.BUFSIZE && size < 64 * 1024 * 1024) continue;
          raiseForCode(rc);
          rows.push({
            cell: mod.HEAP32[cell >> 2],
            tag: mod.UTF8ToString(tag, size),
            pack: mod.UTF8ToString(pack, size),
            ...(readStruct(mod, "SWMM_MeshSnowOverrides", values) as Omit<
              MeshSnowRow,
              "cell" | "tag" | "pack"
            >),
          });
          break;
        } finally {
          mod._free(p);
        }
      }
    }
    return rows;
  }
}
