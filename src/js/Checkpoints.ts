/**
 * @file Checkpoints.ts
 * @brief `solver.checkpoints`: engine checkpoint sessions (Python
 *        `openswmm.engine._checkpoint`).
 *
 * A session starts from OPENED, before the ordinary `initialize()`; saves are
 * taken at accepted step boundaries and restored into a fresh session of a
 * matching model. Output profiles: 0 none, 1 binary, 2 mesh (HDF5), 3
 * combined, 4 files.
 *
 * @license  Apache-2.0
 */

import { raiseForCode } from "./errors.js";
import { checkedAlloc, rawOf } from "./mem.js";
import { withStruct } from "./structs.js";
import { STRUCTS, type RawApi } from "./raw.js";
import type { OpenSwmmWasmModule } from "./types.js";
import { SolverView } from "./view.js";

/** Raise with the checkpoint module's own message. */
function check(raw: RawApi, rc: number): void {
  if (rc) raiseForCode(rc, raw.swmm_checkpoint_last_error_msg() || undefined);
}

function text(value: string): string {
  if (value.includes("\0")) throw new RangeError("Checkpoint path/token contains NUL");
  return value;
}

/** `solver.checkpoints`. */
export class Checkpoints extends SolverView {
  /** @internal */
  private _flags(fn: (h: number, out: number) => number): number {
    const p = checkedAlloc(this._mod, 4);
    try {
      this._mod.HEAPU32[p >> 2] = 0;
      check(this._raw, fn(this._h, p));
      return this._mod.HEAPU32[p >> 2];
    } finally {
      this._mod._free(p);
    }
  }

  /** What this build supports: `SWMM_CHECKPOINT_*` bits 0..8. */
  get capabilities(): number {
    return this._flags(this._raw.swmm_checkpoint_capabilities);
  }

  /** Session state bits: attached 1, boundary 2, fresh 4, managed 8. */
  get sessionStatus(): number {
    return this._flags(this._raw.swmm_checkpoint_session_status);
  }

  /**
   * Initialize and start a checkpoint session from OPENED (instead of
   * `initialize()`). Set fresh output paths first; profiles without binary
   * output need an empty `.out` path. A refusal before initialization keeps
   * OPENED; a later failure closes the engine.
   */
  startSession(
    output = 0,
    {
      sourceHistory,
      detailedSourceIntervals = false,
      ownershipToken,
    }: { sourceHistory?: string; detailedSourceIntervals?: boolean; ownershipToken?: string } = {},
  ): void {
    withStruct(
      this._mod,
      "SWMM_CheckpointSessionOptions",
      (p) => check(this._raw, this._raw.swmm_checkpoint_start_session(this._h, p)),
      {
        struct_size: STRUCTS.SWMM_CheckpointSessionOptions.size,
        schema_version: 1,
        output,
        source_history: text(sourceHistory ?? ""),
        detailed_source_intervals: detailedSourceIntervals ? 1 : 0,
        ownership_token: text(ownershipToken ?? ""),
      },
    );
  }

  /** Validate a checkpoint privately and return its schema-1 metadata, adopting nothing. */
  inspect(path: string): Record<string, unknown> {
    const mod = this._mod;
    const out = checkedAlloc(mod, 8);
    try {
      mod.HEAPU32[out >> 2] = 0;
      check(this._raw, this._raw.swmm_checkpoint_inspect(this._h, text(path), out));
      const snapshot = mod.HEAPU32[out >> 2];
      try {
        const required = out + 4;
        check(this._raw, this._raw.swmm_checkpoint_inspection_json(snapshot, 0, 0, required));
        const size = mod.HEAPU32[required >> 2];
        const buf = checkedAlloc(mod, Math.max(size, 1));
        try {
          check(
            this._raw,
            this._raw.swmm_checkpoint_inspection_json(snapshot, buf, size, required),
          );
          return JSON.parse(mod.UTF8ToString(buf, size)) as Record<string, unknown>;
        } finally {
          mod._free(buf);
        }
      } finally {
        if (snapshot) this._raw.swmm_checkpoint_inspection_destroy(snapshot);
      }
    } finally {
      mod._free(out);
    }
  }

  /** Save at an accepted boundary to a new destination (existing files are kept). */
  save(path: string): void {
    check(this._raw, this._raw.swmm_checkpoint_save(this._h, text(path)));
  }

  /** Restore a matching checkpoint into a fresh session. */
  restore(path: string): void {
    check(this._raw, this._raw.swmm_checkpoint_restore(this._h, text(path)));
  }

  /** Copy a file-backed checkpoint to a new folder (model inputs stay external). */
  static exportBundle(mod: OpenSwmmWasmModule, path: string, newFolder: string): void {
    const raw = rawOf(mod);
    check(raw, raw.swmm_checkpoint_export_bundle(text(path), text(newFolder)));
  }
}
