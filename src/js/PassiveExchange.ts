/**
 * @file PassiveExchange.ts
 * @brief Experimental integrated native passive exchange with read-only V1
 *        snapshots (Python `_passive_exchange`).
 *
 * Amount components keep their canonical order and native concentration or
 * volume basis. Inspection copies carry no ownership or authority to fund a
 * transfer. Access is serialized with the solver: inspection from inside a
 * callback is refused.
 *
 * @license  Apache-2.0
 */

import { raiseForCode } from "./errors.js";
import { STRUCTS } from "./raw.js";
import { readStruct, withStruct } from "./structs.js";
import type { Solver } from "./Solver.js";
import { SolverView } from "./view.js";

/** Exact sum of original ordered components; an empty list represents zero. */
export interface PassiveAmount {
  components: number[];
}

export interface PassiveStatus {
  receiptCount: number;
  legCount: number;
  unsealedLegCount: number;
  pollutant: number;
  units: number;
  failed: number;
  windowOpen: number;
  deliveryFrozen: number;
  historyPreflight: number;
  checkpointAttached: number;
  historyRefused: number;
  elapsedMs: number;
  deliverySeconds: number;
}

export interface PassivePool {
  node: number;
  units: number;
  settledVolumeFt3: number;
  settledDepthFt: number;
  settledConcentration: number;
  settledPhysicalAmount: number;
  hydraulicVolumeFt3: number;
  roundoff: PassiveAmount;
  pendingDrain: PassiveAmount;
  pendingSpill: PassiveAmount;
}

export interface PassiveReceipt {
  id: number;
  rowCount: number;
  firstLeg: number;
  legCount: number;
  generation: number;
  phase: number;
  captureMs: number;
  startMs: number;
  endMs: number;
  eligibleMs: number;
  publicationDeliverySeconds: number;
}

export interface PassiveRow {
  point: number;
  node: number;
  units: number;
  drainWater: PassiveAmount;
  spillWater: PassiveAmount;
  drainAmount: PassiveAmount;
  spillAmount: PassiveAmount;
}

export interface PassiveLeg {
  point: number;
  cell: number;
  node: number;
  drain: number;
  applied: number;
  sealed: number;
  phase: number;
  waterM3: number;
  sourceAmount: number;
  waterFt3: number;
  nativeAmount: number;
  sourceBefore: number;
  sourceAfter: number;
  sampledConcentration: number;
  volumeBeforeM3: number;
  volumeAfterM3: number;
  startMs: number;
  endMs: number;
  offsetSeconds: number;
  durationSeconds: number;
  remainingWaterFt3: number;
  remainingNativeAmount: number;
  /** 0 for an ordinary leg; 1 or 2 for one stage of a second-order step, which moves half. */
  stage: number;
}

type Row = Record<string, unknown>;

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** A native `SWMM_PassiveAmountV1` as its ordered components. */
function amount(value: unknown): PassiveAmount {
  const row = value as { count: number; components: number[] };
  return { components: row.components.slice(0, row.count) };
}

/** camelCase copy of a native row, with amount fields converted. */
function record<T>(row: Row): T {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      camel(k),
      v !== null && typeof v === "object" && "components" in v ? amount(v) : v,
    ]),
  ) as T;
}

/** A uint64 index: a safe non-negative integer or an in-range bigint. */
function u64(value: number | bigint, name: string): bigint {
  if (typeof value === "bigint") {
    if (value >= 0n && value < 2n ** 64n) return value;
  } else if (Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new RangeError(`${name} must be an unsigned 64-bit integer`);
}

/** Integrated reference profile (Python `solver.passive_exchange`). Enable once after `start(false)`, before stepping. */
export class PassiveExchange extends SolverView {
  /** @internal Obtain through {@link Solver.passiveExchange}. */
  constructor(owner: Solver) {
    super(owner, true);
  }

  private _check(rc: number): void {
    if (rc) raiseForCode(rc, this._raw.swmm_passive_exchange_last_error() || undefined);
  }

  /** Run a native call outside callbacks, as Python's `require_idle` + `_operation`. */
  private _call(fn: (h: number) => number): void {
    this._solver._requireIdle();
    const h = this._h;
    this._check(this._solver._operation(() => fn(h)));
  }

  /** Read one native struct `name` filled by `fn(h, size, ptr)`. */
  private _read(
    name: keyof typeof STRUCTS,
    fn: (h: number, size: number, p: number) => number,
  ): Row {
    return withStruct(this._mod, name, (p) => {
      this._call((h) => fn(h, STRUCTS[name].size, p));
      return readStruct(this._mod, name, p);
    });
  }

  /** Enroll the supported passive profile: capacity 1..65536, preflight 0 or 1. */
  enable(capacity: number | bigint = 4096, preflight = 0): void {
    const cap = u64(capacity, "capacity");
    this._call((h) => this._raw.swmm_passive_exchange_enable(h, cap, preflight));
  }

  /** Attach numerical checkpoints at the initial enrolled boundary. */
  enableCheckpoint(): void {
    this._call((h) => this._raw.swmm_passive_exchange_enable_checkpoint(h));
  }

  /** Copy the status observation. */
  status(): PassiveStatus {
    return record(
      this._read("SWMM_PassiveStatusV1", (h, n, p) =>
        this._raw.swmm_passive_exchange_status_v1(h, n, p),
      ),
    );
  }

  /** Copy the pool observation of a node, preserving exact amount components. */
  pool(node: number): PassivePool {
    return record(
      this._read("SWMM_PassivePoolV1", (h, n, p) =>
        this._raw.swmm_passive_exchange_pool_v1(h, node, n, p),
      ),
    );
  }

  /** Copy a receipt observation. */
  receipt(receipt: number | bigint): PassiveReceipt {
    const id = u64(receipt, "receipt");
    return record(
      this._read("SWMM_PassiveReceiptV1", (h, n, p) =>
        this._raw.swmm_passive_exchange_receipt_v1(h, id, n, p),
      ),
    );
  }

  /** Copy one row of a receipt; `remaining` 1 reads what is left to deliver. */
  row(receipt: number | bigint, row: number | bigint, remaining = 0): PassiveRow {
    const id = u64(receipt, "receipt");
    const index = u64(row, "row");
    return record(
      this._read("SWMM_PassiveRowV1", (h, n, p) =>
        this._raw.swmm_passive_exchange_row_v1(h, id, remaining, index, n, p),
      ),
    );
  }

  /** Copy a leg observation with its stage. */
  leg(leg: number | bigint): PassiveLeg {
    const id = u64(leg, "leg");
    return this._leg((h, n, p) => this._raw.swmm_passive_exchange_leg_v2(h, id, n, p));
  }

  /** Copy the current attempt observation with its stage. */
  attempt(): PassiveLeg {
    return this._leg((h, n, p) => this._raw.swmm_passive_exchange_attempt_v2(h, n, p));
  }

  private _leg(fn: (h: number, size: number, p: number) => number): PassiveLeg {
    const value = this._read("SWMM_PassiveLegV2", fn);
    return { ...record<Omit<PassiveLeg, "stage">>(value.leg as Row), stage: value.stage as number };
  }
}
