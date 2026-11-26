/**
 * @file Split.ts
 * @brief Experimental native water peers and the in-process material peer
 *        (Python `_split`).
 *
 * Configure each OPENED peer before initializing, export the surface geometry
 * and apply it to the network, register one network callback, then start both
 * peers. A callback request expires when the callback returns; return a newly
 * owned reply from the surface peer's {@link SplitParticipant.evaluate}. There
 * is no rollback after a failed phase; native eligibility and feature checks
 * remain authoritative.
 *
 * Frames own native snapshots: close owned frames (or use them with `using`)
 * when done, since JavaScript does not free them.
 *
 * @license  Apache-2.0
 */

import type { SplitPhase, SplitRole } from "./enums.js";
import { raiseForCode } from "./errors.js";
import { checkedAlloc, rawOf } from "./mem.js";
import { CALLBACK_SIGNATURES, type RawApi } from "./raw.js";
import { Solver } from "./Solver.js";
import type { OpenSwmmWasmModule } from "./types.js";
import { SolverView } from "./view.js";

/** Largest material packet or callback response, in UTF-8 bytes. */
const MATERIAL_PACKET_MAX_BYTES = 64 * 1024 * 1024;

/** An owned SI node row of a frame. */
export interface SplitFrameNode {
  headM: number;
  depthM: number;
  queuedM3: number;
  directM3: number;
  deliverySeconds: number;
}

/** A reviewed source row of a frame, in native ft³/s and ft³. */
export interface SplitFrameSource {
  rateCfs: number;
  previousRateCfs: number;
  pendingRunoffFt3: number;
  pendingDrainFt3: number;
}

/** Owned snapshot, or a callback-only borrowed request. Close owned frames promptly. */
export class SplitFrame {
  /** @internal */
  _handle = 0;
  /** @internal */
  _owned = true;
  /** @internal */
  private _mod: OpenSwmmWasmModule | null = null;

  /**
   * With a solver, export its initialized surface geometry
   * ({@link SplitParticipant.geometry}); without one, a closed frame.
   */
  constructor(solver?: Solver | null) {
    if (solver === undefined || solver === null) return;
    if (!(solver instanceof Solver)) throw new TypeError("SplitFrame expects a Solver");
    const handle = solver.handle;
    const mod = solver.module;
    this._mod = mod;
    const raw = rawOf(mod);
    this._handle = readHandle(mod, (out) => {
      const rc = solver._operation(() => raw.swmm_split_geometry(handle, out));
      raiseForCode(rc, rc ? raw.swmm_get_last_error_msg(handle) : undefined);
    });
  }

  /** @internal Wrap a native frame handle. */
  static _wrap(mod: OpenSwmmWasmModule, handle: number, owned = true): SplitFrame {
    const frame = new SplitFrame();
    frame._mod = mod;
    frame._handle = handle;
    frame._owned = owned;
    return frame;
  }

  /** @internal The raw API after the open-frame check. */
  _require(): RawApi {
    if (!this._handle || !this._mod) {
      throw new RangeError("Split frame is closed, transferred, or expired");
    }
    return rawOf(this._mod);
  }

  /** Release an owned frame; borrowed callback requests cannot be closed. */
  close(): void {
    if (!this._handle) return;
    const raw = this._require();
    if (!this._owned) throw new RangeError("Cannot close a borrowed callback request");
    raw.swmm_split_frame_destroy(this._handle);
    this._handle = 0;
  }

  /** {@link close}, for `using`. */
  [Symbol.dispose](): void {
    this.close();
  }

  /** Native phase code; zero denotes geometry. */
  get phase(): number {
    return this._require().swmm_split_packet_phase(this._handle);
  }

  /** Sequence number, elapsed interval start and duration in seconds. */
  get time(): [number, number, number] {
    const raw = this._require();
    return this._doubles(
      3,
      (p) => raw.swmm_split_frame_time(this._handle, p, p + 8, p + 16),
      (m, p) => [
        m.HEAPU32[p >> 2] + m.HEAPU32[(p >> 2) + 1] * 2 ** 32,
        m.HEAPF64[(p >> 3) + 1],
        m.HEAPF64[(p >> 3) + 2],
      ],
    );
  }

  /** Owned SI node row: head and depth m, queued and direct m³, delivery seconds. */
  node(index: number): SplitFrameNode {
    const raw = this._require();
    return this._doubles(
      5,
      (p) => raw.swmm_split_frame_node(this._handle, index, p, p + 8, p + 16, p + 24, p + 32),
      (m, p) => {
        const [headM, depthM, queuedM3, directM3, deliverySeconds] = m.HEAPF64.slice(
          p >> 3,
          (p >> 3) + 5,
        );
        return { headM, depthM, queuedM3, directM3, deliverySeconds };
      },
    );
  }

  /** Reviewed source rates in native ft³/s and pending runoff and drain in ft³. */
  source(index: number): SplitFrameSource {
    const raw = this._require();
    return this._doubles(
      4,
      (p) => raw.swmm_split_frame_source(this._handle, index, p, p + 8, p + 16, p + 24),
      (m, p) => {
        const [rateCfs, previousRateCfs, pendingRunoffFt3, pendingDrainFt3] = m.HEAPF64.slice(
          p >> 3,
          (p >> 3) + 4,
        );
        return { rateCfs, previousRateCfs, pendingRunoffFt3, pendingDrainFt3 };
      },
    );
  }

  /** Accepted reviewed-source outfall return of a subcatchment, native ft³. */
  outfallReturn(subcatchment: number): number {
    const raw = this._require();
    return this._doubles(
      1,
      (p) => raw.swmm_split_frame_return(this._handle, subcatchment, p),
      (m, p) => m.HEAPF64[p >> 3],
    );
  }

  /** Run a frame reader over `n` zeroed doubles and decode them. */
  private _doubles<T>(
    n: number,
    call: (p: number) => number,
    decode: (mod: OpenSwmmWasmModule, p: number) => T,
  ): T {
    const mod = this._mod as OpenSwmmWasmModule;
    const p = checkedAlloc(mod, 8 * n);
    try {
      mod.HEAPF64.fill(0, p >> 3, (p >> 3) + n);
      raiseForCode(call(p));
      return decode(mod, p);
    } finally {
      mod._free(p);
    }
  }
}

/** Run `call(out)` with a zeroed pointer slot and return the pointer it wrote. */
function readHandle(mod: OpenSwmmWasmModule, call: (out: number) => void): number {
  const out = checkedAlloc(mod, 4);
  try {
    mod.HEAPU32[out >> 2] = 0;
    call(out);
    return mod.HEAPU32[out >> 2];
  } finally {
    mod._free(out);
  }
}

/** Copy and free a native `char*` text. */
function takeText(mod: OpenSwmmWasmModule, call: (out: number) => void): string {
  const text = readHandle(mod, call);
  try {
    return mod.UTF8ToString(text);
  } finally {
    if (text) rawOf(mod).swmm_split_packet_free(text);
  }
}

function requireFrame(frame: unknown): RawApi {
  if (!(frame instanceof SplitFrame)) throw new TypeError("expected a SplitFrame");
  return frame._require();
}

/** Owner-backed native water peer (Python `solver.split`). */
export class SplitParticipant extends SolverView {
  /** @internal Obtain through {@link Solver.split}. */
  constructor(owner: Solver) {
    if (!(owner instanceof Solver)) throw new TypeError("SplitParticipant expects a Solver");
    super(owner, true);
  }

  /** @internal */
  protected _check(rc: number): void {
    raiseForCode(rc, rc ? this._raw.swmm_get_last_error_msg(this._solver.handle) : undefined);
  }

  /** Check authored eligibility while OPENED, without advancing or opening outputs. */
  validateInput(): void {
    this._check(this._raw.swmm_split_validate_input(this._h));
  }

  /** Select {@link SplitRole.NETWORK} or `SURFACE` once while OPENED, before output binding. */
  configure(role: SplitRole): void {
    this._solver._requireIdle();
    this._check(this._raw.swmm_split_configure(this._h, role));
  }

  /** Export an owned surface geometry frame after initialize, before start. */
  geometry(): SplitFrame {
    const h = this._h;
    const handle = readHandle(this._mod, (out) =>
      this._check(this._solver._operation(() => this._raw.swmm_split_geometry(h, out))),
    );
    return SplitFrame._wrap(this._mod, handle);
  }

  /** Import matching initialized geometry without consuming the frame. */
  applyGeometry(frame: SplitFrame): void {
    requireFrame(frame);
    const h = this._h;
    this._check(
      this._solver._operation(() => this._raw.swmm_split_apply_geometry(h, frame._handle)),
    );
  }

  /**
   * Register `callback(phase, request)` returning an owned reply; `null`
   * unregisters it. Register or unregister only while INITIALIZED, before
   * start; the solver keeps the callback. A borrowed request expires when the
   * callback returns. An error stops native peer exchange and is rethrown by
   * the native call that ran the callback.
   */
  setCallback(callback: ((phase: SplitPhase, request: SplitFrame) => SplitFrame) | null): void {
    if (callback !== null && typeof callback !== "function") {
      throw new TypeError("callback must be callable or null");
    }
    const mod = this._mod;
    this._solver._setCallback(
      "split",
      this._raw.swmm_split_set_callback,
      CALLBACK_SIGNATURES.SWMM_SplitCallback,
      callback &&
        ((_network: number, phase: number, request: number, reply: number) => {
          mod.HEAPU32[reply >> 2] = 0;
          const borrowed = SplitFrame._wrap(mod, request, false);
          try {
            const result: unknown = callback(phase as SplitPhase, borrowed);
            if (!(result instanceof SplitFrame)) {
              throw new TypeError("Split callback must return a newly owned SplitFrame");
            }
            result._require();
            if (!result._owned)
              throw new RangeError("Cannot return the borrowed request as a reply");
            mod.HEAPU32[reply >> 2] = result._handle;
            result._handle = 0; // transferred to the engine
            return 0;
          } finally {
            borrowed._handle = 0;
          }
        }),
      { failed: -1 },
    );
  }

  /** Evaluate or advance the surface for a native request; returns a newly owned reply. */
  evaluate(phase: SplitPhase, request: SplitFrame): SplitFrame {
    requireFrame(request);
    const h = this._h;
    let rc = 0;
    const handle = readHandle(this._mod, (out) => {
      rc = this._solver._operation(() =>
        this._raw.swmm_split_evaluate(h, phase, request._handle, out),
      );
    });
    const reply = SplitFrame._wrap(this._mod, handle);
    try {
      this._solver._rethrowCallbackError();
      this._check(rc);
    } catch (err) {
      reply.close();
      throw err;
    }
    return reply;
  }

  /** Copy a frame to versioned UTF-8 JSON (needs the native packet codec). */
  encode(frame: SplitFrame): string {
    requireFrame(frame);
    const h = this._h;
    return takeText(this._mod, (out) =>
      this._check(
        this._solver._operation(() => this._raw.swmm_split_packet_encode(h, frame._handle, out)),
      ),
    );
  }

  /** Decode JSON into an owned frame without advancing the engine. */
  decode(text: string): SplitFrame {
    if (typeof text !== "string") throw new TypeError("Split packet must be a string");
    if (text.includes("\0")) throw new RangeError("Split packet cannot contain null bytes");
    const h = this._h;
    const bytes = this._mod.lengthBytesUTF8(text);
    const handle = readHandle(this._mod, (out) =>
      this._check(
        this._solver._operation(() => this._raw.swmm_split_packet_decode(h, text, bytes, out)),
      ),
    );
    return SplitFrame._wrap(this._mod, handle);
  }
}

/** Validate a material packet or callback response; returns its UTF-8 byte length. */
function materialBytes(mod: OpenSwmmWasmModule, text: unknown): number {
  if (typeof text !== "string") {
    throw new TypeError("Material packet and callback response must be str");
  }
  const bytes = mod.lengthBytesUTF8(text);
  if (!bytes || bytes > MATERIAL_PACKET_MAX_BYTES || text.includes("\0")) {
    throw new RangeError("Material packet must be nonempty, NUL-free and at most 64 MiB");
  }
  return bytes;
}

/**
 * Trusted in-process material peer (Python `solver.material_split`).
 *
 * Configure OPENED peers, exchange initialized geometry with this codec,
 * install the ordinary phase callback, start both, {@link setTransport}, then
 * {@link bind}. Schema-10 copies convey no authority; native restrictions
 * remain decisive.
 */
export class MaterialSplitParticipant extends SplitParticipant {
  private _checkMaterial(rc: number): void {
    if (rc) raiseForCode(rc, this._raw.swmm_split_material_last_error() || undefined);
  }

  private _checkCheckpoint(rc: number): void {
    if (rc) raiseForCode(rc, this._raw.swmm_split_material_checkpoint_last_error() || undefined);
  }

  /** Check authored material eligibility without selecting a role or advancing. */
  override validateInput(): void {
    this._solver._requireIdle();
    const h = this._h;
    this._checkMaterial(
      this._solver._operation(() => this._raw.swmm_split_material_validate_input(h)),
    );
  }

  /** Select the material NETWORK or SURFACE role while OPENED. */
  override configure(role: SplitRole): void {
    this._solver._requireIdle();
    const h = this._h;
    this._checkMaterial(
      this._solver._operation(() => this._raw.swmm_split_material_configure(h, role)),
    );
  }

  /**
   * Keep `callback(stage, requestJson)` returning the response JSON, for
   * OFFER=1, PROOF=2 and ACK=3. Register on the running network before
   * {@link bind}. Calls run synchronously in the network's native step; an
   * error stops exchange and is rethrown by that step. Reentrant stepping or
   * teardown is refused; codec calls are allowed.
   */
  setTransport(callback: (stage: number, request: string) => string): void {
    if (typeof callback !== "function") throw new TypeError("callback must be callable");
    const mod = this._mod;
    let held = 0; // response storage stays valid after return, until the next call
    const release = () => {
      if (held) mod._free(held);
      held = 0;
    };
    this._solver._setCallback(
      "materialTransport",
      this._raw.swmm_split_material_set_transport,
      CALLBACK_SIGNATURES.SWMM_MaterialTransport,
      (
        _network: number,
        stage: number,
        request: number,
        length: number,
        response: number,
        responseLength: number,
      ) => {
        mod.HEAPU32[response >> 2] = 0;
        mod.HEAPU32[responseLength >> 2] = 0;
        const reply: unknown = callback(stage, mod.UTF8ToString(request, length));
        const bytes = materialBytes(mod, reply);
        release();
        held = checkedAlloc(mod, bytes + 1);
        mod.stringToUTF8(reply as string, held, bytes + 1);
        mod.HEAPU32[response >> 2] = held;
        mod.HEAPU32[responseLength >> 2] = bytes;
        return 0;
      },
      { failed: -1, release, check: (rc) => this._checkMaterial(rc) },
    );
  }

  /** Bind one started surface peer once; both solvers must outlive the pair. */
  bind(surface: Solver, capacity = 4096): void {
    if (!(surface instanceof Solver)) throw new TypeError("bind expects a Solver");
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new RangeError("capacity must be a non-negative integer");
    }
    this._solver._requireIdle();
    surface._requireIdle();
    const h = this._h;
    const peer = surface.handle;
    this._checkMaterial(
      this._solver._operation(() =>
        surface._operation(() => this._raw.swmm_split_material_bind(h, peer, BigInt(capacity))),
      ),
    );
  }

  /** Copy a native boundary frame to schema-10 UTF-8 JSON. */
  override encode(frame: SplitFrame): string {
    requireFrame(frame);
    const h = this._h;
    return takeText(this._mod, (out) =>
      this._checkMaterial(
        this._solver._operation(() =>
          this._raw.swmm_split_material_packet_encode(h, frame._handle, out),
        ),
      ),
    );
  }

  /** Decode a schema-10 boundary packet into a newly owned frame. */
  override decode(text: string): SplitFrame {
    const bytes = materialBytes(this._mod, text);
    const h = this._h;
    const handle = readHandle(this._mod, (out) =>
      this._checkMaterial(
        this._solver._operation(() =>
          this._raw.swmm_split_material_packet_decode(h, text, bytes, out),
        ),
      ),
    );
    return SplitFrame._wrap(this._mod, handle);
  }

  /** Validate and canonicalize a complete boundary, offer, proof or ack JSON value. */
  copyPacket(text: string): string {
    const bytes = materialBytes(this._mod, text);
    const h = this._h;
    return takeText(this._mod, (out) =>
      this._checkMaterial(
        this._solver._operation(() =>
          this._raw.swmm_split_material_packet_copy(h, text, bytes, out),
        ),
      ),
    );
  }

  /** Compiled material checkpoint features: bit 0 numerical state, bit 1 outputs. */
  checkpointCapabilities(): number {
    const h = this._h;
    return readHandle(this._mod, (out) =>
      this._checkCheckpoint(
        this._solver._operation(() =>
          this._raw.swmm_split_material_checkpoint_capabilities(h, out),
        ),
      ),
    );
  }

  /** Prepare this INITIALIZED role's checkpointable writer before start. */
  checkpointPrepareOutputs(): void {
    this._solver._requireIdle();
    const h = this._h;
    this._checkCheckpoint(
      this._solver._operation(() => this._raw.swmm_split_material_checkpoint_prepare_outputs(h)),
    );
  }

  /** Enable pair recovery once on the bound NETWORK at its fresh RUNNING boundary. */
  checkpointEnable(outputs = false): void {
    this._solver._requireIdle();
    const h = this._h;
    this._checkCheckpoint(
      this._solver._operation(() =>
        this._raw.swmm_split_material_checkpoint_enable(h, outputs ? 1 : 0),
      ),
    );
  }

  /** Capture the bound pair at an acknowledged boundary as same-platform native bytes. */
  checkpointCapture(): Uint8Array {
    this._solver._requireIdle();
    const h = this._h;
    const raw = this._raw;
    const mod = this._mod;
    const snapshot = readHandle(mod, (out) =>
      this._checkCheckpoint(
        this._solver._operation(() => raw.swmm_split_material_checkpoint_capture(h, out)),
      ),
    );
    const view = checkedAlloc(mod, 8);
    try {
      this._checkCheckpoint(raw.swmm_split_material_checkpoint_data(snapshot, view, view + 4));
      const data = mod.HEAPU32[view >> 2];
      return mod.HEAPU8.slice(data, data + mod.HEAPU32[(view >> 2) + 1]);
    } finally {
      mod._free(view);
      raw.swmm_split_material_checkpoint_destroy(snapshot);
    }
  }

  /**
   * Restore fresh, identically bound roles from {@link checkpointCapture}
   * bytes. With `expectedSeconds`, the saved clock must equal it exactly.
   */
  checkpointRestore(data: Uint8Array, expectedSeconds: number | null = null): void {
    if (!(data instanceof Uint8Array)) throw new TypeError("data must be a Uint8Array");
    this._solver._requireIdle();
    const raw = this._raw;
    const mod = this._mod;
    const bytes = checkedAlloc(mod, Math.max(data.length, 1));
    let snapshot = 0;
    try {
      mod.HEAPU8.set(data, bytes);
      snapshot = readHandle(mod, (out) =>
        this._checkCheckpoint(
          raw.swmm_split_material_checkpoint_from_bytes(bytes, data.length, out),
        ),
      );
    } finally {
      mod._free(bytes);
    }
    try {
      const h = this._h;
      this._checkCheckpoint(
        this._solver._operation(() =>
          expectedSeconds === null
            ? raw.swmm_split_material_checkpoint_restore(h, snapshot)
            : raw.swmm_split_material_checkpoint_restore_at(h, snapshot, expectedSeconds),
        ),
      );
    } finally {
      raw.swmm_split_material_checkpoint_destroy(snapshot);
    }
  }
}
