/**
 * @file Links.ts
 * @brief Link collection and individual link accessor for the OpenSWMM WASM bindings.
 *
 * @details Mirrors the Python `_links.pyi` binding specification:
 * - {@link Links} is an iterable collection of all links in the model.
 * - {@link Link} is a single-link accessor with typed property getters/setters.
 *
 * @author   Caleb Buahin <caleb.buahin@gmail.com>
 * @copyright Copyright (c) 2026 Caleb Buahin. All rights reserved.
 * @license  Apache-2.0
 */

import { LinkType, OrificeType, OutletRatingType, WeirType, XSectShape } from "./enums.js";
import { ElementNotFoundError, StaleObjectError, raiseForCode } from "./errors.js";
import type { OpenSwmmWasmModule } from "./types.js";
import type { RawApi } from "./raw.js";
import type { ModelBuilder } from "./ModelBuilder.js";
import type { Solver } from "./Solver.js";
import { checkedAlloc, guardedRaw, withInt } from "./mem.js";
import {
  bulkRead,
  getDouble,
  getDoubles,
  getInt,
  getText,
  resolveIndex,
  type ElementCtx,
} from "./element.js";
import { CrossSection } from "./geometry.js";
import type { Node, Nodes } from "./Nodes.js";
import { XSectionGeometry } from "./XSectionGeometry.js";

// =============================================================================
// Link sub-views (Python LinkStatsView, XSection, PumpView, WeirView,
// OrificeView, OutletView)
// =============================================================================

/** Accumulated statistics of a link (`link.stats`); the pump fields read 0 for other links. */
export class LinkStatsView {
  /** @internal */
  constructor(private readonly _link: Link) {}

  /** @internal */
  private _d(pick: (raw: RawApi) => (e: number, i: number, out: number) => number): number {
    const c = this._link._ctx();
    return getDouble(c, pick(c.raw));
  }

  /** Peak flow. */
  get maxFlow(): number {
    return this._d((r) => r.swmm_link_get_stat_max_flow);
  }
  /** Peak velocity. */
  get maxVelocity(): number {
    return this._d((r) => r.swmm_link_get_stat_max_velocity);
  }
  /** Peak depth / full depth. */
  get maxFilling(): number {
    return this._d((r) => r.swmm_link_get_stat_max_filling);
  }
  /** Total volume conveyed. */
  get volFlow(): number {
    return this._d((r) => r.swmm_link_get_stat_vol_flow);
  }
  /** Time surcharged. */
  get surchargeTime(): number {
    return this._d((r) => r.swmm_link_get_stat_surcharge_time);
  }
  /** Peak share of flow through the Preissmann slot (finite-volume routing; 0 otherwise). */
  get peakSlotShare(): number {
    return this._d((r) => r.swmm_link_get_stat_peak_slot_share);
  }
  /** Time-integrated slot share (finite-volume routing; 0 otherwise). */
  get slotShare(): number {
    return this._d((r) => r.swmm_link_get_stat_slot_share);
  }
  /** Pump start-ups. */
  get pumpCycles(): number {
    const c = this._link._ctx();
    return getInt(c, c.raw.swmm_link_get_stat_pump_cycles);
  }
  /** Pump running time. */
  get pumpOnTime(): number {
    return this._d((r) => r.swmm_link_get_stat_pump_on_time);
  }
  /** Volume pumped. */
  get pumpVolume(): number {
    return this._d((r) => r.swmm_link_get_stat_pump_volume);
  }
}

/**
 * A link's cross-section (`link.xsect`): shape and geom1..geom4, read fresh
 * on each access. Assign `link.xsect = [shape, g1, g2, g3, g4]` to change it.
 */
export class XSection {
  /** @internal */
  constructor(private readonly _link: Link) {}

  /** `[shape, g1, g2, g3, g4]`. */
  asTuple(): [XSectShape, number, number, number, number] {
    const c = this._link._ctx();
    const p = checkedAlloc(c.mod, 40);
    try {
      raiseForCode(c.raw.swmm_link_get_xsect(c.engine, c.index, p, p + 8, p + 16, p + 24, p + 32));
      const g = (k: number) => c.mod.HEAPF64[((p + 8) >> 3) + k];
      return [c.mod.HEAP32[p >> 2] as XSectShape, g(0), g(1), g(2), g(3)];
    } finally {
      c.mod._free(p);
    }
  }

  /** Shape ({@link XSectShape}). */
  get shape(): XSectShape {
    return this.asTuple()[0];
  }
  /** First geometry parameter (usually the full depth). */
  get g1(): number {
    return this.asTuple()[1];
  }
  /** Second geometry parameter. */
  get g2(): number {
    return this.asTuple()[2];
  }
  /** Third geometry parameter. */
  get g3(): number {
    return this.asTuple()[3];
  }
  /** Fourth geometry parameter. */
  get g4(): number {
    return this.asTuple()[4];
  }

  /** The labeled {@link CrossSection}. */
  info(): CrossSection {
    const [s, g1, g2, g3, g4] = this.asTuple();
    return CrossSection.fromRaw(s, g1, g2, g3, g4);
  }

  /** The engine's hydraulic geometry for this section (a copy; destroy it when done). */
  geometry(): XSectionGeometry {
    return XSectionGeometry.fromLink(this._link);
  }

  [Symbol.iterator](): Iterator<number> {
    return this.asTuple()[Symbol.iterator]();
  }
}

/** Pump parameters (`link.pump`, PUMP links only). */
export class PumpView {
  /** @internal */
  constructor(private readonly _link: Link) {}

  /** Index of the pump curve. */
  get curve(): number {
    const c = this._link._ctx();
    return getInt(c, c.raw.swmm_link_get_pump_curve);
  }
  set curve(curveIdx: number) {
    const c = this._link._ctx();
    raiseForCode(c.raw.swmm_link_set_pump_curve(c.engine, c.index, curveIdx));
  }
  /** Whether the pump starts on. */
  get initState(): boolean {
    const c = this._link._ctx();
    return getInt(c, c.raw.swmm_link_get_pump_init_state) !== 0;
  }
  set initState(on: boolean) {
    const c = this._link._ctx();
    raiseForCode(c.raw.swmm_link_set_pump_init_state(c.engine, c.index, on ? 1 : 0));
  }
  /** Inlet depth at which the pump turns on. */
  get startupDepth(): number {
    const c = this._link._ctx();
    return getDouble(c, c.raw.swmm_link_get_pump_startup_depth);
  }
  set startupDepth(depth: number) {
    const c = this._link._ctx();
    raiseForCode(c.raw.swmm_link_set_pump_startup_depth(c.engine, c.index, depth));
  }
  /** Inlet depth at which the pump turns off. */
  get shutoffDepth(): number {
    const c = this._link._ctx();
    return getDouble(c, c.raw.swmm_link_get_pump_shutoff_depth);
  }
  set shutoffDepth(depth: number) {
    const c = this._link._ctx();
    raiseForCode(c.raw.swmm_link_set_pump_shutoff_depth(c.engine, c.index, depth));
  }
}

/** Weir parameters (`link.weir`, WEIR links only). */
export class WeirView {
  /** @internal */
  constructor(private readonly _link: Link) {}

  /** Weir type ({@link WeirType}). */
  get type(): WeirType {
    const c = this._link._ctx();
    return getInt(c, c.raw.swmm_link_get_weir_type) as WeirType;
  }
  set type(value: WeirType) {
    const c = this._link._ctx();
    raiseForCode(c.raw.swmm_link_set_weir_type(c.engine, c.index, value));
  }
  /** Crest height above the inlet invert. */
  get crestHeight(): number {
    const c = this._link._ctx();
    return getDouble(c, c.raw.swmm_link_get_crest_height);
  }
  set crestHeight(h: number) {
    const c = this._link._ctx();
    raiseForCode(c.raw.swmm_link_set_crest_height(c.engine, c.index, h));
  }
  /** Discharge coefficient. */
  get dischargeCoeff(): number {
    const c = this._link._ctx();
    return getDouble(c, c.raw.swmm_link_get_discharge_coeff);
  }
  set dischargeCoeff(cd: number) {
    const c = this._link._ctx();
    raiseForCode(c.raw.swmm_link_set_discharge_coeff(c.engine, c.index, cd));
  }
  /** Number of end contractions. */
  get endContractions(): number {
    const c = this._link._ctx();
    return getDouble(c, c.raw.swmm_link_get_end_contractions);
  }
  set endContractions(n: number) {
    const c = this._link._ctx();
    raiseForCode(c.raw.swmm_link_set_end_contractions(c.engine, c.index, n));
  }
}

/** Orifice parameters (`link.orifice`, ORIFICE links only). */
export class OrificeView {
  /** @internal */
  constructor(private readonly _link: Link) {}

  /** Orifice type ({@link OrificeType}). */
  get type(): OrificeType {
    const c = this._link._ctx();
    return getInt(c, c.raw.swmm_link_get_orifice_type) as OrificeType;
  }
  set type(value: OrificeType) {
    const c = this._link._ctx();
    raiseForCode(c.raw.swmm_link_set_orifice_type(c.engine, c.index, value));
  }
  /** Time to open or close fully. */
  get openCloseRate(): number {
    const c = this._link._ctx();
    return getDouble(c, c.raw.swmm_link_get_orifice_open_close_rate);
  }
  set openCloseRate(rate: number) {
    const c = this._link._ctx();
    raiseForCode(c.raw.swmm_link_set_orifice_open_close_rate(c.engine, c.index, rate));
  }
}

/** Outlet parameters (`link.outlet`, OUTLET links only). */
export class OutletView {
  /** @internal */
  constructor(private readonly _link: Link) {}

  /** Rating type ({@link OutletRatingType}). */
  get ratingType(): OutletRatingType {
    const c = this._link._ctx();
    return getInt(c, c.raw.swmm_link_get_outlet_rating_type) as OutletRatingType;
  }
  set ratingType(value: OutletRatingType) {
    const c = this._link._ctx();
    raiseForCode(c.raw.swmm_link_set_outlet_rating_type(c.engine, c.index, value));
  }
  /** Exponent of the functional rating Q = C·h^expon. */
  get expon(): number {
    const c = this._link._ctx();
    return getDouble(c, c.raw.swmm_link_get_outlet_expon);
  }
  set expon(value: number) {
    const c = this._link._ctx();
    raiseForCode(c.raw.swmm_link_set_outlet_expon(c.engine, c.index, value));
  }
}

// =============================================================================
// Link
// =============================================================================

/**
 * Accessor for a single SWMM link (conduit, pump, orifice, weir, or outlet).
 *
 * Obtain instances via {@link Links.get} or by iterating a {@link Links}
 * collection — do not construct directly.
 */
export class Link {
  /** @internal */
  private readonly _mod: OpenSwmmWasmModule;
  private readonly _raw: RawApi;
  /** @internal */
  private readonly _engine: number;
  /** @internal */
  private readonly _collection: Links;
  /** @internal */
  private readonly _generation: number;

  /** Zero-based index of this link in the model's link list. */
  readonly index: number;

  /** @internal */
  constructor(
    mod: OpenSwmmWasmModule,
    engine: number,
    collection: Links,
    generation: number,
    index: number,
  ) {
    this._mod = mod;
    this._raw = guardedRaw(mod, () => collection.assertAlive());
    this._engine = engine;
    this._collection = collection;
    this._generation = generation;
    this.index = index;
  }

  /** @internal */
  private _checkStale(): void {
    if (this._generation !== this._collection.generation) {
      throw new StaleObjectError();
    }
  }

  /** @internal This link's engine context, after the staleness check. */
  _ctx(): ElementCtx {
    this._checkStale();
    return { mod: this._mod, raw: this._raw, engine: this._engine, index: this.index };
  }

  /** @internal A new native copy of this link's cross-section, for `XSectionGeometry.fromLink`. */
  _newXsectHandle(): [OpenSwmmWasmModule, number] {
    this._checkStale();
    const out = checkedAlloc(this._mod, 4);
    try {
      raiseForCode(this._raw.swmm_link_create_xsect(this._engine, this.index, out));
      return [this._mod, this._mod.HEAPU32[out >> 2]];
    } finally {
      this._mod._free(out);
    }
  }

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  /** String identifier of this link. */
  get id(): string {
    this._checkStale();
    return this._raw.swmm_link_id(this._engine, this.index);
  }

  /** Link classification. */
  get type(): LinkType {
    this._checkStale();
    const ptr = checkedAlloc(this._mod, 4);
    try {
      raiseForCode(this._raw.swmm_link_get_type(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "i32") as LinkType;
    } finally {
      this._mod._free(ptr);
    }
  }

  // -------------------------------------------------------------------------
  // Hydraulic state
  // -------------------------------------------------------------------------

  /** Current flow rate through this link (flow units). */
  get flow(): number {
    this._checkStale();
    const ptr = checkedAlloc(this._mod, 8);
    try {
      raiseForCode(this._raw.swmm_link_get_flow(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Set the current flow (available in RUNNING state for conduits). */
  set flow(value: number) {
    this._checkStale();
    raiseForCode(this._raw.swmm_link_set_flow(this._engine, this.index, value));
  }

  /** Water depth at the upstream end (m or ft). */
  get depth(): number {
    this._checkStale();
    const ptr = checkedAlloc(this._mod, 8);
    try {
      raiseForCode(this._raw.swmm_link_get_depth(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Flow velocity (m/s or ft/s). */
  get velocity(): number {
    this._checkStale();
    const ptr = checkedAlloc(this._mod, 8);
    try {
      raiseForCode(this._raw.swmm_link_get_velocity(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /**
   * Current flow as a fraction of full-pipe capacity (0–1, may exceed 1 for
   * surcharged conduits).
   */
  get capacity(): number {
    this._checkStale();
    const ptr = checkedAlloc(this._mod, 8);
    try {
      raiseForCode(this._raw.swmm_link_get_capacity(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Stored volume in this link (m³ or ft³). */
  get volume(): number {
    this._checkStale();
    const ptr = checkedAlloc(this._mod, 8);
    try {
      raiseForCode(this._raw.swmm_link_get_volume(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  // -------------------------------------------------------------------------
  // Control settings
  // -------------------------------------------------------------------------

  /**
   * Current control setting (opening fraction for orifices/weirs/outlets,
   * on/off for pumps).
   */
  get controlSetting(): number {
    this._checkStale();
    const ptr = checkedAlloc(this._mod, 8);
    try {
      raiseForCode(this._raw.swmm_link_get_control_setting(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Set the control setting (0–1 for throttled links). */
  set controlSetting(value: number) {
    this._checkStale();
    raiseForCode(this._raw.swmm_link_set_control_setting(this._engine, this.index, value));
  }

  /** Target control setting (value the real-time controller is converging to). */
  get targetSetting(): number {
    this._checkStale();
    const ptr = checkedAlloc(this._mod, 8);
    try {
      raiseForCode(this._raw.swmm_link_get_target_setting(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "double");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Set the target control setting. */
  set targetSetting(value: number) {
    this._checkStale();
    raiseForCode(this._raw.swmm_link_set_target_setting(this._engine, this.index, value));
  }

  /** Whether this link is currently closed (1) or open (0). */
  get isClosed(): boolean {
    this._checkStale();
    const ptr = checkedAlloc(this._mod, 4);
    try {
      raiseForCode(this._raw.swmm_link_get_closed(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "i32") !== 0;
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Close or open this link. */
  set isClosed(value: boolean) {
    this._checkStale();
    raiseForCode(this._raw.swmm_link_set_closed(this._engine, this.index, value ? 1 : 0));
  }

  // -------------------------------------------------------------------------
  // Topology
  // -------------------------------------------------------------------------

  /** Zero-based index of the upstream (from) node. */
  get fromNodeIndex(): number {
    this._checkStale();
    const ptr = checkedAlloc(this._mod, 4);
    try {
      raiseForCode(this._raw.swmm_link_get_from_node(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "i32");
    } finally {
      this._mod._free(ptr);
    }
  }

  /** Zero-based index of the downstream (to) node. */
  get toNodeIndex(): number {
    this._checkStale();
    const ptr = checkedAlloc(this._mod, 4);
    try {
      raiseForCode(this._raw.swmm_link_get_to_node(this._engine, this.index, ptr));
      return this._mod.getValue(ptr, "i32");
    } finally {
      this._mod._free(ptr);
    }
  }

  // -------------------------------------------------------------------------
  // Python Link members (wave B)
  // -------------------------------------------------------------------------

  /** The solver (or model builder) this link belongs to. */
  get solver(): Solver | ModelBuilder | null {
    return this._collection.solver;
  }

  /** @internal The owner's node collection. */
  private _nodes(): Nodes {
    const owner = this._collection.solver;
    if (!owner) throw new ElementNotFoundError(this.index, "link has no owner to look nodes up in");
    return owner.nodes;
  }

  /** Upstream node. */
  get fromNode(): Node {
    return this._nodes().get(this.fromNodeIndex);
  }

  /** Downstream node. */
  get toNode(): Node {
    return this._nodes().get(this.toNodeIndex);
  }

  /** Reconnect the link (nodes as views, indices or ids). */
  setNodes(fromNode: Node | number | string, toNode: Node | number | string): void {
    const c = this._ctx();
    const idx = (n: Node | number | string) =>
      typeof n === "object" ? n.index : resolveIndex(c.raw, c.engine, "node", n);
    raiseForCode(c.raw.swmm_link_set_nodes(c.engine, c.index, idx(fromNode), idx(toNode)));
  }

  /** The link's tag (`[TAGS]`). */
  get tag(): string {
    const c = this._ctx();
    return getText(c, c.raw.swmm_link_get_tag);
  }
  set tag(value: string) {
    const c = this._ctx();
    raiseForCode(c.raw.swmm_link_set_tag(c.engine, c.index, value ?? ""));
  }

  /** Conduit length. */
  get length(): number {
    const c = this._ctx();
    return getDouble(c, c.raw.swmm_link_get_length);
  }
  set length(value: number) {
    const c = this._ctx();
    raiseForCode(c.raw.swmm_link_set_length(c.engine, c.index, value));
  }

  /** Manning roughness. */
  get roughness(): number {
    const c = this._ctx();
    return getDouble(c, c.raw.swmm_link_get_roughness);
  }
  set roughness(value: number) {
    const c = this._ctx();
    raiseForCode(c.raw.swmm_link_set_roughness(c.engine, c.index, value));
  }

  /** Conduit slope. */
  get slope(): number {
    const c = this._ctx();
    return getDouble(c, c.raw.swmm_link_get_slope);
  }

  /** Inlet offset above the upstream invert. */
  get offsetUp(): number {
    const c = this._ctx();
    return getDouble(c, c.raw.swmm_link_get_offset_up);
  }
  set offsetUp(value: number) {
    const c = this._ctx();
    raiseForCode(c.raw.swmm_link_set_offset_up(c.engine, c.index, value));
  }

  /** Outlet offset above the downstream invert. */
  get offsetDn(): number {
    const c = this._ctx();
    return getDouble(c, c.raw.swmm_link_get_offset_dn);
  }
  set offsetDn(value: number) {
    const c = this._ctx();
    raiseForCode(c.raw.swmm_link_set_offset_dn(c.engine, c.index, value));
  }

  /** Initial flow. */
  get initialFlow(): number {
    const c = this._ctx();
    return getDouble(c, c.raw.swmm_link_get_initial_flow);
  }
  set initialFlow(value: number) {
    const c = this._ctx();
    raiseForCode(c.raw.swmm_link_set_initial_flow(c.engine, c.index, value));
  }

  /** Flow limit (0 = none). */
  get maxFlow(): number {
    const c = this._ctx();
    return getDouble(c, c.raw.swmm_link_get_max_flow);
  }
  set maxFlow(value: number) {
    const c = this._ctx();
    raiseForCode(c.raw.swmm_link_set_max_flow(c.engine, c.index, value));
  }

  /** Cross-section view; assign `[shape, g1, g2, g3, g4]` (or an XSection) to change it. */
  get xsect(): XSection {
    return new XSection(this);
  }
  set xsect(value: XSection | [XSectShape | number, number, number, number, number]) {
    const [shape, g1, g2, g3, g4] = value instanceof XSection ? value.asTuple() : value;
    const c = this._ctx();
    raiseForCode(c.raw.swmm_link_set_xsect(c.engine, c.index, shape, g1, g2, g3, g4));
  }

  /** Volume in the Preissmann slot. */
  get slotVolume(): number {
    const c = this._ctx();
    return getDouble(c, c.raw.swmm_link_get_slot_volume);
  }

  /** Hydraulic power. */
  get hydPower(): number {
    const c = this._ctx();
    return getDouble(c, c.raw.swmm_link_get_hyd_power);
  }

  /** `[inlet, outlet, average]` minor-loss coefficients. */
  get lossCoeff(): [number, number, number] {
    const c = this._ctx();
    return getDoubles(c, 3, c.raw.swmm_link_get_loss_coeff) as [number, number, number];
  }
  set lossCoeff([inlet, outlet, avg]: [number, number, number]) {
    const c = this._ctx();
    raiseForCode(c.raw.swmm_link_set_loss_coeff(c.engine, c.index, inlet, outlet, avg));
  }

  /** Whether the link has a flap gate. */
  get flapGate(): boolean {
    const c = this._ctx();
    return getInt(c, c.raw.swmm_link_get_flap_gate) !== 0;
  }
  set flapGate(value: boolean) {
    const c = this._ctx();
    raiseForCode(c.raw.swmm_link_set_flap_gate(c.engine, c.index, value ? 1 : 0));
  }

  /** Seepage loss rate. */
  get seepRate(): number {
    const c = this._ctx();
    return getDouble(c, c.raw.swmm_link_get_seep_rate);
  }
  set seepRate(rate: number) {
    const c = this._ctx();
    raiseForCode(c.raw.swmm_link_set_seep_rate(c.engine, c.index, rate));
  }

  /** Culvert inlet geometry code (0 = not a culvert). */
  get culvertCode(): number {
    const c = this._ctx();
    return getInt(c, c.raw.swmm_link_get_culvert_code);
  }
  set culvertCode(code: number) {
    const c = this._ctx();
    raiseForCode(c.raw.swmm_link_set_culvert_code(c.engine, c.index, code));
  }

  /** Number of barrels. */
  get barrels(): number {
    const c = this._ctx();
    return getInt(c, c.raw.swmm_link_get_barrels);
  }
  set barrels(n: number) {
    const c = this._ctx();
    raiseForCode(c.raw.swmm_link_set_barrels(c.engine, c.index, n));
  }

  /** Concentration of a pollutant (by index or id). */
  quality(pollutant: number | string): number {
    const c = this._ctx();
    const q = resolveIndex(c.raw, c.engine, "pollutant", pollutant);
    return getDouble(c, (e, i, out) => c.raw.swmm_link_get_quality(e, i, q, out));
  }

  /** Accumulated statistics. */
  get stats(): LinkStatsView {
    return new LinkStatsView(this);
  }

  /** @internal */
  private _subview<T>(want: LinkType, name: string, make: () => T): T {
    const type = this.type;
    if (type !== want) {
      throw new TypeError(
        `link ${JSON.stringify(this.id)} is a ${LinkType[type]}, not ${LinkType[want]}; ` +
          `the .${name} sub-view is only valid for ${LinkType[want].toLowerCase()} links`,
      );
    }
    return make();
  }

  /** Pump parameters. @throws TypeError unless the link is a PUMP */
  get pump(): PumpView {
    return this._subview(LinkType.PUMP, "pump", () => new PumpView(this));
  }
  /** Weir parameters. @throws TypeError unless the link is a WEIR */
  get weir(): WeirView {
    return this._subview(LinkType.WEIR, "weir", () => new WeirView(this));
  }
  /** Orifice parameters. @throws TypeError unless the link is an ORIFICE */
  get orifice(): OrificeView {
    return this._subview(LinkType.ORIFICE, "orifice", () => new OrificeView(this));
  }
  /** Outlet parameters. @throws TypeError unless the link is an OUTLET */
  get outlet(): OutletView {
    return this._subview(LinkType.OUTLET, "outlet", () => new OutletView(this));
  }
}

// =============================================================================
// Links collection
// =============================================================================

/**
 * Iterable collection of all links in the current model.
 *
 * Obtain via {@link Solver.links}. Supports numeric index and string-ID lookup
 * as well as `for…of` iteration.
 *
 * @example
 * ```ts
 * const links = solver.links;
 * console.log(links.length);
 *
 * const c1 = links.get("C1");
 * console.log(c1.flow, c1.velocity, c1.capacity);
 *
 * // Bulk access — avoids per-call overhead
 * const flows = links.flows;
 * ```
 */
export class Links implements Iterable<Link> {
  /** @internal */
  private readonly _mod: OpenSwmmWasmModule;
  private readonly _raw: RawApi;
  /** @internal */
  private readonly _engine: number;

  /**
   * Generation counter incremented whenever the engine is re-opened.
   * @internal
   */
  generation: number = 0;

  /** @internal */
  /** @internal Check the owner before touching native memory. */
  assertAlive(): void {
    this._checkOwner();
  }

  constructor(
    mod: OpenSwmmWasmModule,
    engine: number,
    private readonly _checkOwner: () => void = () => {},
    /** The solver (or model builder) that owns the collection. */
    readonly solver: Solver | ModelBuilder | null = null,
  ) {
    this._mod = mod;
    this._raw = guardedRaw(mod, this._checkOwner);
    this._engine = engine;
  }

  // -------------------------------------------------------------------------
  // Collection interface
  // -------------------------------------------------------------------------

  /** Number of links in the model. */
  get length(): number {
    return this._raw.swmm_link_count(this._engine);
  }

  /**
   * Look up a link by zero-based index or string ID.
   *
   * @throws {@link ElementNotFoundError} if not found.
   */
  get(indexOrId: number | string): Link {
    if (typeof indexOrId === "string") {
      const idx = this._raw.swmm_link_index(this._engine, indexOrId);
      if (idx < 0) throw new ElementNotFoundError(indexOrId);
      return new Link(this._mod, this._engine, this, this.generation, idx);
    }
    const count = this.length;
    if (indexOrId < 0 || indexOrId >= count) {
      throw new ElementNotFoundError(
        indexOrId,
        `Link index ${indexOrId} out of range [0, ${count})`,
      );
    }
    return new Link(this._mod, this._engine, this, this.generation, indexOrId);
  }

  /** True when a link with this index or id exists. */
  has(key: number | string): boolean {
    if (typeof key === "string") return this.getIndex(key) >= 0;
    return Number.isInteger(key) && key >= 0 && key < this.length;
  }

  /** Every link id, in index order. */
  get ids(): string[] {
    return Array.from({ length: this.length }, (_, i) => this.getId(i));
  }

  /** Add a link of a {@link LinkType}; earlier link views become stale, as in Python. */
  add(linkId: string, linkType: LinkType): Link {
    raiseForCode(this._raw.swmm_link_add(this._engine, linkId, linkType));
    this.generation++;
    return this.get(linkId);
  }

  /** Remove the last link, which must be `linkId`. Earlier link views become stale. */
  popLast(linkId: string): void {
    raiseForCode(this._raw.swmm_link_pop_last(this._engine, linkId));
    this.generation++;
  }

  /** Rename a link; references follow. Earlier link views become stale. */
  rename(key: number | string, newId: string): void {
    raiseForCode(this._raw.swmm_link_rename(this._engine, this.get(key).index, newId));
    this.generation++;
  }

  /** A link's cross-section as a labeled {@link CrossSection}. */
  getXsectInfo(key: number | string): CrossSection {
    return this.get(key).xsect.info();
  }

  /**
   * Flip links drawn against their authored direction back. Returns how many
   * changed; any change invalidates earlier link views.
   */
  restoreAuthoredOrientation(): number {
    const n = withInt(this._mod, (p) =>
      this._raw.swmm_links_restore_authored_orientation(this._engine, p),
    );
    if (n) this.generation++;
    return n;
  }

  /** Volume of every link. */
  get volumes(): Float64Array {
    return bulkRead(this._mod, this.length, (p, n) =>
      this._raw.swmm_link_get_volumes_bulk(this._engine, p, n),
    );
  }

  /** Control setting of every link. */
  get controlSettings(): Float64Array {
    return bulkRead(this._mod, this.length, (p, n) =>
      this._raw.swmm_link_get_control_settings_bulk(this._engine, p, n),
    );
  }

  /** Target setting of every link. */
  get targetSettings(): Float64Array {
    return bulkRead(this._mod, this.length, (p, n) =>
      this._raw.swmm_link_get_target_settings_bulk(this._engine, p, n),
    );
  }

  /** Hydraulic power of every link. */
  get hydPowers(): Float64Array {
    return bulkRead(this._mod, this.length, (p, n) =>
      this._raw.swmm_link_get_hyd_powers_bulk(this._engine, p, n),
    );
  }

  /** Concentration of a pollutant (by index or id) in every link. */
  qualities(pollutant: number | string): Float64Array {
    const q = resolveIndex(this._raw, this._engine, "pollutant", pollutant);
    return bulkRead(this._mod, this.length, (p, n) =>
      this._raw.swmm_link_get_quality_bulk(this._engine, q, p, n),
    );
  }

  /** `[cycles, onTime, volume]` per link; non-pump links have zeros. */
  pumpStats(): [Int32Array, Float64Array, Float64Array] {
    const n = this.length;
    if (n === 0) return [new Int32Array(0), new Float64Array(0), new Float64Array(0)];
    const cycleBytes = 8 * Math.ceil(n / 2); // int32 cycles, padded so the doubles stay 8-aligned
    const bytes = cycleBytes + 16 * n;
    const p = checkedAlloc(this._mod, bytes);
    try {
      this._mod.HEAPU8.fill(0, p, p + bytes);
      const onTime = p + cycleBytes;
      const volume = onTime + 8 * n;
      raiseForCode(this._raw.swmm_link_get_pump_stats_bulk(this._engine, p, onTime, volume, n));
      return [
        this._mod.HEAP32.slice(p >> 2, (p >> 2) + n),
        this._mod.HEAPF64.slice(onTime >> 3, (onTime >> 3) + n),
        this._mod.HEAPF64.slice(volume >> 3, (volume >> 3) + n),
      ];
    } finally {
      this._mod._free(p);
    }
  }

  /** Return the zero-based index for a string link ID, or -1 if not found. */
  getIndex(id: string): number {
    return this._raw.swmm_link_index(this._engine, id);
  }

  /** Return the string ID for a zero-based link index. */
  getId(idx: number): string {
    const id = this._raw.swmm_link_id(this._engine, idx);
    if (!id) throw new ElementNotFoundError(idx, `Link index ${idx} out of range`);
    return id;
  }

  // -------------------------------------------------------------------------
  // Bulk array accessors
  // -------------------------------------------------------------------------

  /** Flow rates of all links (flow units). */
  get flows(): Float64Array {
    const n = this.length;
    const result = new Float64Array(n);
    const ptr = checkedAlloc(this._mod, 8);
    try {
      for (let i = 0; i < n; i++) {
        raiseForCode(this._raw.swmm_link_get_flow(this._engine, i, ptr));
        result[i] = this._mod.getValue(ptr, "double");
      }
    } finally {
      this._mod._free(ptr);
    }
    return result;
  }

  /** Depths at the upstream end of all links (m or ft). */
  get depths(): Float64Array {
    const n = this.length;
    const result = new Float64Array(n);
    const ptr = checkedAlloc(this._mod, 8);
    try {
      for (let i = 0; i < n; i++) {
        raiseForCode(this._raw.swmm_link_get_depth(this._engine, i, ptr));
        result[i] = this._mod.getValue(ptr, "double");
      }
    } finally {
      this._mod._free(ptr);
    }
    return result;
  }

  /** Flow velocities of all links (m/s or ft/s). */
  get velocities(): Float64Array {
    const n = this.length;
    const result = new Float64Array(n);
    const ptr = checkedAlloc(this._mod, 8);
    try {
      for (let i = 0; i < n; i++) {
        raiseForCode(this._raw.swmm_link_get_velocity(this._engine, i, ptr));
        result[i] = this._mod.getValue(ptr, "double");
      }
    } finally {
      this._mod._free(ptr);
    }
    return result;
  }

  /** Capacity fractions of all links (0–1+). */
  get capacities(): Float64Array {
    const n = this.length;
    const result = new Float64Array(n);
    const ptr = checkedAlloc(this._mod, 8);
    try {
      for (let i = 0; i < n; i++) {
        raiseForCode(this._raw.swmm_link_get_capacity(this._engine, i, ptr));
        result[i] = this._mod.getValue(ptr, "double");
      }
    } finally {
      this._mod._free(ptr);
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Iteration
  // -------------------------------------------------------------------------

  [Symbol.iterator](): Iterator<Link> {
    let i = 0;
    const length = this.length;
    return {
      next: (): IteratorResult<Link> => {
        if (i < length) {
          return { value: this.get(i++), done: false };
        }
        return { value: undefined as unknown as Link, done: true };
      },
    };
  }
}
