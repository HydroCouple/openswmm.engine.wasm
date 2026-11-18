/**
 * @file Trace.ts
 * @brief Flow tracing over hydraulic output or supplied hydraulic averages
 *        (Python `_trace`).
 *
 * All dimensional quantities are SI. Travel times are passage-weighted
 * estimates under frozen average flows, not particle arrival times. A
 * {@link FlowTracer} owns its inputs; close it (or use it with `using`).
 *
 * @license  Apache-2.0
 */

import { LinkType, NodeType, TraceDirection, TraceStatus } from "./enums.js";
import type { TraceTerminal } from "./enums.js";
import { ElementNotFoundError } from "./errors.js";
import { checkedAlloc, rawOf } from "./mem.js";
import { CALLBACK_SIGNATURES, STRUCTS, type RawApi } from "./raw.js";
import { readStruct, withStruct, withStructs, type StructValue } from "./structs.js";
import type { OpenSwmmWasmModule } from "./types.js";

/** Topology node; flags describe ponding and external exchanges. */
export interface TraceNode {
  id: string;
  type: NodeType;
  /** `TraceNodeFlags` bits. */
  flags: number;
}

/** Topology link; endpoint indices refer to the supplied node order. */
export interface TraceLink {
  id: string;
  fromNode: number;
  toNode: number;
  type: LinkType;
  lengthM: number;
}

/** Numerical thresholds in SI units ({@link FlowTracer.defaultOptions} gives the native defaults). */
export interface TraceOptions {
  flowEpsilonM3s: number;
  velocityEpsilonMps: number;
  reversalDominance: number;
  solverTolerance: number;
  maxIterations: number;
}

/** Hydraulic node averages in SI units. */
export interface TraceNodeAverage {
  volumeM3: number;
  inflowM3s: number;
  lateralInM3s: number;
  withdrawalM3s: number;
  overflowM3s: number;
  outgoingM3s: number;
  residenceS: number;
  firstVolumeM3: number;
  lastVolumeM3: number;
  /** `TraceFlags` bits. */
  flags: number;
}

/** Hydraulic link averages in SI units. */
export interface TraceLinkAverage {
  netFlowM3s: number;
  absoluteFlowM3s: number;
  absoluteVelocityMps: number;
  forwardVolumeM3: number;
  reverseVolumeM3: number;
  travelS: number;
  firstVolumeM3: number;
  lastVolumeM3: number;
  direction: number;
  /** `TraceFlags` bits. */
  flags: number;
}

/** Scan metadata; report dates are OLE Automation days. */
export interface TraceInfo {
  schemaVersion: number;
  algorithmVersion: number;
  nodeCount: number;
  linkCount: number;
  periods: number;
  sourceFlowUnits: number;
  cacheLoaded: number;
  firstReportDate: number;
  lastReportDate: number;
  durationS: number;
}

/** Passage ratio and timing; NaN denotes unknown time or trapped circulation. */
export interface TraceValue {
  ratio: number;
  timeS: number;
  timeCoverage: number;
  fromTimeS: number;
  toTimeS: number;
  terminalFraction: number;
  terminalKind: TraceTerminal | null;
  /** `TraceFlags` bits. */
  flags: number;
}

/** Accounting totals; index the terminal fractions with {@link TraceTerminal}. */
export interface TraceSummary {
  terminal: number[];
  accountingError: number;
  solverResidual: number;
  boundaryInM3: number;
  boundaryOutM3: number;
  lateralInM3: number;
  withdrawalM3: number;
  knownLossM3: number;
  storageChangeM3: number;
  partialBalanceResidualM3: number;
  cyclic: number;
  reachedNodes: number;
  reachedLinks: number;
}

/** Results in topology order, with terminal and continuity accounting. */
export interface TraceResult {
  nodes: TraceValue[];
  links: TraceValue[];
  summary: TraceSummary;
}

/** Progress callback: `(fraction, stage)`; returning true cancels. */
export type TraceProgress = (fraction: number, stage: string) => boolean | void;

/** Native tracing failure; `code` is a {@link TraceStatus}, separate from engine errors. */
export class TraceError extends Error {
  readonly code: TraceStatus;
  constructor(code: TraceStatus, message?: string) {
    super(message || `Flow tracing failed (${TraceStatus[code] ?? code})`);
    this.name = "TraceError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** camelCase copy of a native row. */
function record<T>(row: Record<string, unknown>): T {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [camel(k), v])) as T;
}

/** snake_case native values of a record over `defaults`. */
function native(defaults: object, values: object | null | undefined): StructValue {
  const out: StructValue = {};
  for (const [k, v] of Object.entries({ ...defaults, ...(values ?? {}) })) {
    if (v !== undefined) out[snake(k)] = v as number;
  }
  return out;
}

function text(value: unknown): string {
  const s = String(value);
  if (s.includes("\0")) throw new RangeError("Trace strings cannot contain NUL characters");
  return s;
}

const NODE_AVERAGE: TraceNodeAverage = {
  volumeM3: 0,
  inflowM3s: 0,
  lateralInM3s: 0,
  withdrawalM3s: 0,
  overflowM3s: 0,
  outgoingM3s: 0,
  residenceS: 0,
  firstVolumeM3: 0,
  lastVolumeM3: 0,
  flags: 0,
};

const LINK_AVERAGE: TraceLinkAverage = {
  netFlowM3s: 0,
  absoluteFlowM3s: 0,
  absoluteVelocityMps: 0,
  forwardVolumeM3: 0,
  reverseVolumeM3: 0,
  travelS: 0,
  firstVolumeM3: 0,
  lastVolumeM3: 0,
  direction: 0,
  flags: 0,
};

const TRACE_INFO: TraceInfo = {
  schemaVersion: 0,
  algorithmVersion: 0,
  nodeCount: 0,
  linkCount: 0,
  periods: 0,
  sourceFlowUnits: 0,
  cacheLoaded: 0,
  firstReportDate: 0,
  lastReportDate: 0,
  durationS: 0,
};

/** Independent tracing handle (Python `FlowTracer`); close it or use it with `using`. */
export class FlowTracer {
  private _handle = 0;
  private _busy = false;
  private readonly _raw: RawApi;
  private readonly _nn: number;
  private readonly _nl: number;

  /**
   * Copy a topology into a new native handle. Missing fields take the Python
   * dataclass defaults; `options` fields default to the native values.
   */
  constructor(
    private readonly _mod: OpenSwmmWasmModule,
    nodes: Iterable<Partial<TraceNode>>,
    links: Iterable<Partial<TraceLink>>,
    { options = null }: { options?: Partial<TraceOptions> | null } = {},
  ) {
    this._raw = rawOf(_mod);
    const ns = Array.from(nodes, (n) => ({
      id: text(n.id ?? ""),
      type: n.type ?? NodeType.JUNCTION,
      flags: n.flags ?? 0,
    }));
    const ls = Array.from(links, (l) => ({
      id: text(l.id ?? ""),
      from_node: l.fromNode ?? 0,
      to_node: l.toNode ?? 0,
      type: l.type ?? LinkType.CONDUIT,
      length_m: l.lengthM ?? 0,
    }));
    this._nn = ns.length;
    this._nl = ls.length;
    const opts = native(FlowTracer.defaultOptions(_mod), options);
    const out = checkedAlloc(_mod, 4);
    try {
      _mod.HEAPU32[out >> 2] = 0;
      const status = withStructs(_mod, "SWMM_TraceNodeInput", ns, (np) =>
        withStructs(_mod, "SWMM_TraceLinkInput", ls, (lp) =>
          withStruct(
            _mod,
            "SWMM_TraceOptions",
            (op) => this._raw.swmm_trace_create(np, ns.length, lp, ls.length, op, out),
            opts,
          ),
        ),
      );
      this._handle = _mod.HEAPU32[out >> 2];
      this._check(status);
    } finally {
      _mod._free(out);
    }
  }

  /** The native numerical defaults in SI units. */
  static defaultOptions(mod: OpenSwmmWasmModule): TraceOptions {
    return withStruct(mod, "SWMM_TraceOptions", (p) => {
      rawOf(mod).swmm_trace_default_options(p);
      return record<TraceOptions>(readStruct(mod, "SWMM_TraceOptions", p));
    });
  }

  private _check(status: number): void {
    if (status) {
      throw new TraceError(status as TraceStatus, this._raw.swmm_trace_error(this._handle) || "");
    }
  }

  /** The open handle, refused while an operation (or its progress callback) runs. */
  private _h(): number {
    if (this._busy) throw new Error("FlowTracer is in use by another operation");
    if (!this._handle) throw new Error("FlowTracer is closed");
    return this._handle;
  }

  /** Release this handle; repeated closes are harmless. */
  close(): void {
    if (this._busy) throw new Error("FlowTracer is in use by another operation");
    if (this._handle) {
      this._raw.swmm_trace_close(this._handle);
      this._handle = 0;
    }
  }

  /** {@link close}, for `using`. */
  [Symbol.dispose](): void {
    this.close();
  }

  /** Node IDs in the original topology order. */
  get nodeIds(): string[] {
    const h = this._h();
    return Array.from({ length: this._nn }, (_, i) => this._raw.swmm_trace_node_id(h, i));
  }

  /** Link IDs in the original topology order. */
  get linkIds(): string[] {
    const h = this._h();
    return Array.from({ length: this._nl }, (_, i) => this._raw.swmm_trace_link_id(h, i));
  }

  /** Copies of the node and link inputs, in input order. */
  get topology(): [TraceNode[], TraceLink[]] {
    const h = this._h();
    return this._pair("SWMM_TraceNodeInput", "SWMM_TraceLinkInput", (np, lp) =>
      this._raw.swmm_trace_get_topology(h, np, this._nn, lp, this._nl),
    ) as [TraceNode[], TraceLink[]];
  }

  /** Scan metadata, including topology counts and cache status. */
  get info(): TraceInfo {
    const h = this._h();
    return withStruct(this._mod, "SWMM_TraceInfo", (p) => {
      this._check(this._raw.swmm_trace_get_info(h, p));
      return record<TraceInfo>(readStruct(this._mod, "SWMM_TraceInfo", p));
    });
  }

  /** Prepared hydraulic averages and derived delays in SI units. */
  get averages(): [TraceNodeAverage[], TraceLinkAverage[]] {
    const h = this._h();
    return this._pair("SWMM_TraceNodeAverage", "SWMM_TraceLinkAverage", (np, lp) =>
      this._raw.swmm_trace_get_averages(h, np, this._nn, lp, this._nl),
    ) as [TraceNodeAverage[], TraceLinkAverage[]];
  }

  /** Read two native row arrays (one per node, one per link) filled by `fill`. */
  private _pair(
    nodeStruct: keyof typeof STRUCTS,
    linkStruct: keyof typeof STRUCTS,
    fill: (nodes: number, links: number) => number,
  ): [unknown[], unknown[]] {
    const mod = this._mod;
    const nsize = STRUCTS[nodeStruct].size;
    const lsize = STRUCTS[linkStruct].size;
    const nodes = checkedAlloc(mod, nsize * Math.max(this._nn, 1));
    const links = checkedAlloc(mod, lsize * Math.max(this._nl, 1));
    try {
      this._check(fill(nodes, links));
      return [
        Array.from({ length: this._nn }, (_, i) =>
          record(readStruct(mod, nodeStruct, nodes + i * nsize)),
        ),
        Array.from({ length: this._nl }, (_, i) =>
          record(readStruct(mod, linkStruct, links + i * lsize)),
        ),
      ];
    } finally {
      mod._free(nodes);
      mod._free(links);
    }
  }

  /** Restore averages in topology order; derived delays are recomputed. */
  setAverages(
    nodes: Iterable<Partial<TraceNodeAverage>>,
    links: Iterable<Partial<TraceLinkAverage>>,
    { info = null }: { info?: Partial<TraceInfo> | null } = {},
  ): void {
    this._h();
    const ns = Array.from(nodes, (n) => native(NODE_AVERAGE, n));
    const ls = Array.from(links, (l) => native(LINK_AVERAGE, l));
    if (ns.length !== this._nn || ls.length !== this._nl) {
      throw new RangeError("Average row counts must match the topology");
    }
    const h = this._h();
    const status = withStructs(this._mod, "SWMM_TraceNodeAverage", ns, (np) =>
      withStructs(this._mod, "SWMM_TraceLinkAverage", ls, (lp) =>
        withStruct(
          this._mod,
          "SWMM_TraceInfo",
          (ip) => this._raw.swmm_trace_set_averages(h, np, this._nn, lp, this._nl, info ? ip : 0),
          native(TRACE_INFO, info),
        ),
      ),
    );
    this._check(status);
  }

  /** Run a long native operation with an optional progress callback. */
  private _run(
    progress: TraceProgress | null | undefined,
    call: (h: number, callback: number) => number,
  ): void {
    const h = this._h();
    if (progress !== null && progress !== undefined && typeof progress !== "function") {
      throw new TypeError("progress must be callable");
    }
    let error: unknown;
    let failed = false;
    const slot = progress
      ? this._mod.addFunction((fraction: number, stage: number) => {
          try {
            return progress(fraction, stage ? this._mod.UTF8ToString(stage) : "") ? 1 : 0;
          } catch (err) {
            // Never let a JavaScript error unwind through the native frames.
            error = err;
            failed = true;
            return 1;
          }
        }, CALLBACK_SIGNATURES.SWMM_TraceProgress)
      : 0;
    let status: number;
    this._busy = true;
    try {
      status = call(h, slot);
    } finally {
      this._busy = false;
      if (slot) this._mod.removeFunction(slot);
    }
    if (failed) throw error;
    this._check(status);
  }

  /**
   * Read a completed output, matching topology by ID rather than row order.
   * A cache needs HDF5 and a verified content digest in `fingerprint` (for
   * example SHA-256 of the output bytes); a path or timestamp is not enough.
   */
  prepare(
    outputPath: string,
    {
      cachePath = null,
      fingerprint = null,
      progress = null,
    }: {
      cachePath?: string | null;
      fingerprint?: string | null;
      progress?: TraceProgress | null;
    } = {},
  ): void {
    const output = text(outputPath);
    const cache = cachePath === null ? "" : text(cachePath);
    const digest = fingerprint === null ? "" : text(fingerprint);
    this._h();
    if (cache && !digest) {
      throw new RangeError("A cache requires a verified output content fingerprint");
    }
    this._run(progress, (h, cb) => this._raw.swmm_trace_prepare(h, output, cache, digest, cb, 0));
  }

  /**
   * Scan the complete reporting periods of a growing or cancelled output (no
   * footer or cache needed). Appends during the scan are ignored; call again
   * to refresh. Truncation raises a {@link TraceError} with `MISMATCH`.
   */
  prepareLive(
    outputPath: string,
    { progress = null }: { progress?: TraceProgress | null } = {},
  ): void {
    const output = text(outputPath);
    this._run(progress, (h, cb) => this._raw.swmm_trace_prepare_live(h, output, cb, 0));
  }

  /**
   * Trace upstream or downstream from a node ID or zero-based index. Results
   * keep NaN for unknown times and repeat passage ratios above one for cycles.
   */
  estimate(
    seed: string | number,
    direction: TraceDirection = TraceDirection.DOWNSTREAM,
    { progress = null }: { progress?: TraceProgress | null } = {},
  ): TraceResult {
    this._h();
    let index: number;
    if (typeof seed === "string") {
      index = this.nodeIds.indexOf(seed);
      if (index < 0) throw new ElementNotFoundError(seed);
    } else if (typeof seed === "number" && Number.isInteger(seed)) {
      index = seed;
    } else {
      throw new TypeError("Trace seed must be a node ID or an integer index");
    }
    if (!(direction in TraceDirection) || typeof direction !== "number") {
      throw new RangeError(`${String(direction)} is not a valid TraceDirection`);
    }
    if (index < 0 || index >= this._nn) {
      throw new RangeError("Trace seed index is outside the topology");
    }
    const mod = this._mod;
    const vsize = STRUCTS.SWMM_TraceValue.size;
    const nodes = checkedAlloc(mod, vsize * Math.max(this._nn, 1));
    const links = checkedAlloc(mod, vsize * Math.max(this._nl, 1));
    const summary = checkedAlloc(mod, STRUCTS.SWMM_TraceSummary.size);
    try {
      this._run(progress, (h, cb) =>
        this._raw.swmm_trace_estimate(
          h,
          direction,
          index,
          nodes,
          this._nn,
          links,
          this._nl,
          summary,
          cb,
          0,
        ),
      );
      const value = (p: number): TraceValue => {
        const row = record<TraceValue>(readStruct(mod, "SWMM_TraceValue", p));
        return { ...row, terminalKind: (row.terminalKind as number) < 0 ? null : row.terminalKind };
      };
      return {
        nodes: Array.from({ length: this._nn }, (_, i) => value(nodes + i * vsize)),
        links: Array.from({ length: this._nl }, (_, i) => value(links + i * vsize)),
        summary: record<TraceSummary>(readStruct(mod, "SWMM_TraceSummary", summary)),
      };
    } finally {
      mod._free(nodes);
      mod._free(links);
      mod._free(summary);
    }
  }
}
