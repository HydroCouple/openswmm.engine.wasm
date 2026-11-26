/**
 * @file Inflows.ts
 * @brief `solver.inflows`: external and dry-weather inflows, RDII, unit
 *        hydrographs and RDII decay (Python `openswmm.engine._inflows`).
 *
 * Entries are addressed by their row index in each table; removing a row
 * shifts the later ones.
 *
 * @license  Apache-2.0
 */

import { raiseForCode } from "./errors.js";
import { resolveIndex } from "./element.js";
import { checkedAlloc, withCString, withCStrings } from "./mem.js";
import { SolverView } from "./view.js";

/** `[RDII]` row. */
export interface RDIIEntry {
  nodeIndex: number;
  uhName: string;
  area: number;
}

/** `[HYDROGRAPHS]` row: one response of one month of a unit-hydrograph group. */
export interface HydrographEntry {
  uhName: string;
  month: number;
  response: number;
  r: number;
  t: number;
  k: number;
  dmax: number;
  drecov: number;
  dinit: number;
}

/** A unit-hydrograph group's rain gage. */
export interface HydrographGageEntry {
  uhName: string;
  gageName: string;
}

/** RDII decay parameters of one response of a unit-hydrograph group. */
export interface RDIIDecayEntry {
  uhName: string;
  response: number;
  k_dep: number;
  k_0: number;
  k_T: number;
  T_ref: number;
  theta_rec: number;
  T_freeze: number;
  snow_on: boolean;
  snow_T: number;
  snow_ddf: number;
}

/** RDII decay parameters as given to {@link Inflows.addRdiiDecay} (snow ones optional). */
export type RDIIDecayParams = Omit<
  RDIIDecayEntry,
  "uhName" | "response" | "snow_on" | "snow_T" | "snow_ddf"
> &
  Partial<Pick<RDIIDecayEntry, "snow_on" | "snow_T" | "snow_ddf">>;

/** `[node, constituent, tsName, type, mFactor, sFactor, baseline, pattern]`. */
export type ExternalInflow = [number, string, string, string, number, number, number, string];

/** `[node, constituent, avgValue, monthly, daily, hourly, weekend]` patterns. */
export type DryWeatherInflow = [number, string, number, string, string, string, string];

/** `solver.inflows`. */
export class Inflows extends SolverView {
  /** @internal Scratch out-parameters around `fn`. */
  private _scratch<T>(bytes: number, fn: (p: number) => T): T {
    const p = checkedAlloc(this._mod, bytes);
    try {
      this._mod.HEAPU8.fill(0, p, p + bytes);
      return fn(p);
    } finally {
      this._mod._free(p);
    }
  }

  // ---- External inflows ([INFLOWS]) -------------------------------------

  /**
   * Add an external inflow of `constituent` ("FLOW" or a pollutant) at a node:
   * a time series scaled by `mFactor`·`sFactor`, plus a baseline × pattern.
   */
  addExternal(
    node: number | string,
    constituent: string,
    {
      tsName = "",
      type = "FLOW",
      mFactor = 1,
      sFactor = 1,
      baseline = 0,
      pattern = "",
    }: {
      tsName?: string;
      type?: string;
      mFactor?: number;
      sFactor?: number;
      baseline?: number;
      pattern?: string;
    } = {},
  ): void {
    const n = resolveIndex(this._raw, this._h, "node", node);
    raiseForCode(
      this._raw.swmm_ext_inflow_add(
        this._h,
        n,
        constituent,
        tsName,
        type,
        mFactor,
        sFactor,
        baseline,
        pattern,
      ),
    );
  }

  /** Number of external inflow rows. */
  get externalCount(): number {
    return this._raw.swmm_ext_inflow_count(this._h);
  }

  /** An external inflow row. */
  getExternal(entryIdx: number): ExternalInflow {
    return this._scratch(32, (p) => {
      const [constituent, ts, type, pattern] = withCStrings(
        this._mod,
        256,
        4,
        ([a, b, c, d], len) =>
          this._raw.swmm_ext_inflow_get(
            this._h,
            entryIdx,
            p,
            a,
            len,
            b,
            len,
            c,
            len,
            p + 8,
            p + 16,
            p + 24,
            d,
            len,
          ),
      );
      const f = this._mod.HEAPF64;
      return [
        this._mod.HEAP32[p >> 2],
        constituent,
        ts,
        type,
        f[(p + 8) >> 3],
        f[(p + 16) >> 3],
        f[(p + 24) >> 3],
        pattern,
      ];
    });
  }

  /** Remove an external inflow row. */
  removeExternal(entryIdx: number): void {
    raiseForCode(this._raw.swmm_ext_inflow_remove(this._h, entryIdx));
  }

  /** Change an external inflow's scale factor. */
  setExternalScale(entryIdx: number, scale: number): void {
    raiseForCode(this._raw.swmm_ext_inflow_set_scale(this._h, entryIdx, scale));
  }

  /** Change an external inflow's baseline. */
  setExternalBaseline(entryIdx: number, baseline: number): void {
    raiseForCode(this._raw.swmm_ext_inflow_set_baseline(this._h, entryIdx, baseline));
  }

  // ---- Dry-weather inflows ([DWF]) -----------------------------------------

  /** Add a dry-weather inflow: an average value with optional time patterns. */
  addDwf(
    node: number | string,
    constituent: string,
    {
      avgValue = 0,
      monthlyPattern = "",
      dailyPattern = "",
      hourlyPattern = "",
      weekendPattern = "",
    }: {
      avgValue?: number;
      monthlyPattern?: string;
      dailyPattern?: string;
      hourlyPattern?: string;
      weekendPattern?: string;
    } = {},
  ): void {
    const n = resolveIndex(this._raw, this._h, "node", node);
    raiseForCode(
      this._raw.swmm_dwf_add(
        this._h,
        n,
        constituent,
        avgValue,
        monthlyPattern,
        dailyPattern,
        hourlyPattern,
        weekendPattern,
      ),
    );
  }

  /** Number of dry-weather inflow rows. */
  get dwfCount(): number {
    return this._raw.swmm_dwf_count(this._h);
  }

  /** A dry-weather inflow row. */
  getDwf(entryIdx: number): DryWeatherInflow {
    return this._scratch(16, (p) => {
      const [constituent, p1, p2, p3, p4] = withCStrings(
        this._mod,
        256,
        5,
        ([a, b, c, d, e], len) =>
          this._raw.swmm_dwf_get(
            this._h,
            entryIdx,
            p,
            a,
            len,
            p + 8,
            b,
            len,
            c,
            len,
            d,
            len,
            e,
            len,
          ),
      );
      return [
        this._mod.HEAP32[p >> 2],
        constituent,
        this._mod.HEAPF64[(p + 8) >> 3],
        p1,
        p2,
        p3,
        p4,
      ];
    });
  }

  /** Remove a dry-weather inflow row. */
  removeDwf(entryIdx: number): void {
    raiseForCode(this._raw.swmm_dwf_remove(this._h, entryIdx));
  }

  /** Change a dry-weather inflow's average value. */
  setDwfBaseline(entryIdx: number, avgValue: number): void {
    raiseForCode(this._raw.swmm_dwf_set_baseline(this._h, entryIdx, avgValue));
  }

  // ---- RDII ([RDII]) ---------------------------------------------------------

  /** Assign a unit-hydrograph group and sewershed area to a node. */
  addRdii(node: number | string, uhName: string, area: number): void {
    const n = resolveIndex(this._raw, this._h, "node", node);
    raiseForCode(this._raw.swmm_rdii_add(this._h, n, uhName, area));
  }

  /** An RDII row. */
  getRdii(idx: number): RDIIEntry {
    return this._scratch(16, (p) => {
      const uhName = withCString(this._mod, 256, (buf, len) =>
        this._raw.swmm_rdii_get(this._h, idx, p, buf, len, p + 8),
      );
      return { nodeIndex: this._mod.HEAP32[p >> 2], uhName, area: this._mod.HEAPF64[(p + 8) >> 3] };
    });
  }

  /** Number of RDII rows. */
  get rdiiCount(): number {
    return this._raw.swmm_rdii_count(this._h);
  }

  /** Remove an RDII row. */
  removeRdii(entryIdx: number): void {
    raiseForCode(this._raw.swmm_rdii_remove(this._h, entryIdx));
  }

  // ---- Unit hydrographs ([HYDROGRAPHS]) -----------------------------------------

  /** Add one response (1 short, 2 medium, 3 long) of one month (0 = all) of a group. */
  addHydrograph(
    uhName: string,
    month: number,
    response: number,
    r: number,
    t: number,
    k: number,
    { dmax = 0, drecov = 0, dinit = 0 }: { dmax?: number; drecov?: number; dinit?: number } = {},
  ): void {
    raiseForCode(
      this._raw.swmm_hydrograph_add(this._h, uhName, month, response, r, t, k, dmax, drecov, dinit),
    );
  }

  /** A hydrograph row. */
  getHydrograph(idx: number): HydrographEntry {
    return this._scratch(56, (p) => {
      const uhName = withCString(this._mod, 256, (buf, len) =>
        this._raw.swmm_hydrograph_get(
          this._h,
          idx,
          buf,
          len,
          p,
          p + 4,
          p + 8,
          p + 16,
          p + 24,
          p + 32,
          p + 40,
          p + 48,
        ),
      );
      const f = (o: number) => this._mod.HEAPF64[(p + o) >> 3];
      return {
        uhName,
        month: this._mod.HEAP32[p >> 2],
        response: this._mod.HEAP32[(p + 4) >> 2],
        r: f(8),
        t: f(16),
        k: f(24),
        dmax: f(32),
        drecov: f(40),
        dinit: f(48),
      };
    });
  }

  /** Number of hydrograph rows. */
  get hydrographCount(): number {
    return this._raw.swmm_hydrograph_count(this._h);
  }

  /** Change a response's R, T and K. */
  setHydrographRtk(
    uhName: string,
    month: number,
    response: number,
    r: number,
    t: number,
    k: number,
  ): void {
    raiseForCode(this._raw.swmm_hydrograph_set_rtk(this._h, uhName, month, response, r, t, k));
  }

  /** Change a response's initial abstraction (Dmax, Drecov, Dinit). */
  setHydrographIa(
    uhName: string,
    month: number,
    response: number,
    dmax: number,
    drecov: number,
    dinit: number,
  ): void {
    raiseForCode(
      this._raw.swmm_hydrograph_set_ia(this._h, uhName, month, response, dmax, drecov, dinit),
    );
  }

  /** Remove one response of one month. */
  removeHydrographEntry(uhName: string, month: number, response: number): void {
    raiseForCode(this._raw.swmm_hydrograph_remove_entry(this._h, uhName, month, response));
  }

  /** Remove a whole unit-hydrograph group. */
  removeHydrographGroup(uhName: string): void {
    raiseForCode(this._raw.swmm_hydrograph_remove_group(this._h, uhName));
  }

  /** Remove every month-specific row of a group (keeps the all-months rows). */
  clearHydrographGroupMonths(uhName: string): void {
    raiseForCode(this._raw.swmm_hydrograph_clear_group_months(this._h, uhName));
  }

  /** Rename a unit-hydrograph group (by group index). */
  renameHydrographGroup(idx: number, newId: string): void {
    raiseForCode(this._raw.swmm_hydrograph_group_rename(this._h, idx, newId));
  }

  /** Set a group's rain gage. */
  setHydrographGage(uhName: string, gageName: string): void {
    raiseForCode(this._raw.swmm_hydrograph_set_gage(this._h, uhName, gageName));
  }

  /** Add a group-to-gage row. */
  addHydrographGage(uhName: string, gageName: string): void {
    raiseForCode(this._raw.swmm_hydrograph_add_gage(this._h, uhName, gageName));
  }

  /** A group-to-gage row. */
  getHydrographGage(idx: number): HydrographGageEntry {
    const [uhName, gageName] = withCStrings(this._mod, 256, 2, ([a, b], len) =>
      this._raw.swmm_hydrograph_get_gage(this._h, idx, a, len, b, len),
    );
    return { uhName, gageName };
  }

  /** Number of group-to-gage rows. */
  get hydrographGageCount(): number {
    return this._raw.swmm_hydrograph_gage_count(this._h);
  }

  /** Number of unit-hydrograph groups. */
  get hydrographGroupCount(): number {
    return this._raw.swmm_hydrograph_group_count(this._h);
  }

  /** Id of a unit-hydrograph group. */
  getHydrographGroupId(idx: number): string {
    return withCString(this._mod, 256, (buf, len) =>
      this._raw.swmm_hydrograph_group_id(this._h, idx, buf, len),
    );
  }

  // ---- RDII decay ------------------------------------------------------------------

  /** Add RDII decay parameters for one response of a group. */
  addRdiiDecay(uhName: string, response: number, p: RDIIDecayParams): void {
    raiseForCode(
      this._raw.swmm_rdii_decay_add(
        this._h,
        uhName,
        response,
        p.k_dep,
        p.k_0,
        p.k_T,
        p.T_ref,
        p.theta_rec,
        p.T_freeze,
        p.snow_on ? 1 : 0,
        p.snow_T ?? 1,
        p.snow_ddf ?? 0,
      ),
    );
  }

  /** Change the RDII decay parameters of one response of a group. */
  setRdiiDecay(uhName: string, response: number, p: RDIIDecayParams): void {
    raiseForCode(
      this._raw.swmm_rdii_decay_set(
        this._h,
        uhName,
        response,
        p.k_dep,
        p.k_0,
        p.k_T,
        p.T_ref,
        p.theta_rec,
        p.T_freeze,
        p.snow_on ? 1 : 0,
        p.snow_T ?? 1,
        p.snow_ddf ?? 0,
      ),
    );
  }

  /** An RDII decay row. */
  getRdiiDecay(idx: number): RDIIDecayEntry {
    return this._scratch(80, (p) => {
      const uhName = withCString(this._mod, 256, (buf, len) =>
        this._raw.swmm_rdii_decay_get(
          this._h,
          idx,
          buf,
          len,
          p,
          p + 8,
          p + 16,
          p + 24,
          p + 32,
          p + 40,
          p + 48,
          p + 56,
          p + 64,
          p + 72,
        ),
      );
      const f = (o: number) => this._mod.HEAPF64[(p + o) >> 3];
      return {
        uhName,
        response: this._mod.HEAP32[p >> 2],
        k_dep: f(8),
        k_0: f(16),
        k_T: f(24),
        T_ref: f(32),
        theta_rec: f(40),
        T_freeze: f(48),
        snow_on: this._mod.HEAP32[(p + 56) >> 2] !== 0,
        snow_T: f(64),
        snow_ddf: f(72),
      };
    });
  }

  /** Number of RDII decay rows. */
  get rdiiDecayCount(): number {
    return this._raw.swmm_rdii_decay_count(this._h);
  }

  /** Remove the RDII decay of one response of a group. */
  removeRdiiDecay(uhName: string, response: number): void {
    raiseForCode(this._raw.swmm_rdii_decay_remove(this._h, uhName, response));
  }
}
