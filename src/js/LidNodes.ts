/**
 * @file LidNodes.ts
 * @brief Ordered storage-node LID layers and layer treatments, in the
 *        model's rainfall depth/rate units (Python
 *        `openswmm.engine._lid_nodes`).
 *
 * @license  Apache-2.0
 */

/** Kind of an authored LID node layer. */
export enum LidNodeLayerKind {
  SURFACE = 0,
  MEDIA = 1,
  AGGREGATE = 2,
  BOTTOM = 3,
}

const PARAM_COUNTS = [2, 7, 3, 2];

/**
 * One authored layer; MEDIA and AGGREGATE repeat freely, top to bottom.
 * `params`: SURFACE (thickness, vegetation fraction), MEDIA (thickness,
 * porosity, field capacity, wilting point, Ksat, Kslope, suction), AGGREGATE
 * (thickness, porosity, Ksat), BOTTOM (seepage, clog factor). Thickness and
 * suction are in or mm; conductivity and seepage in/hr or mm/hr. BOTTOM is a
 * boundary and takes no layer number for outlet anchors.
 */
export class LidNodeLayer {
  readonly kind: LidNodeLayerKind;
  readonly params: readonly number[];

  constructor(kind: LidNodeLayerKind, params: readonly number[]) {
    const expected = PARAM_COUNTS[kind];
    if (expected === undefined) throw new RangeError(`${kind} is not a valid LidNodeLayerKind`);
    if (params.length !== expected) {
      throw new RangeError(`${LidNodeLayerKind[kind]} requires ${expected} parameters`);
    }
    this.kind = kind;
    this.params = Object.freeze(params.map(Number));
    Object.freeze(this);
  }
}

/**
 * Treatment on a one-based physical layer: removal percent and decay per
 * day. The optional `R=` or `C=` expression acts after the fixed removal on
 * outgoing water; decay acts on retained mass once per routing step.
 */
export class LidLayerTreatment {
  constructor(
    readonly layer: number,
    readonly pollutant: string,
    readonly removalPercent = 0,
    readonly decayPerDay = 0,
    readonly expression = "",
  ) {
    Object.freeze(this);
  }
}
