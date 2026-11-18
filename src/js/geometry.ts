/**
 * @file geometry.ts
 * @brief Cross-section parameters with labels (Python `openswmm.engine._geometry`).
 *
 * `CrossSection` names the raw `(shape, geom1..geom4)` a link reports. For the
 * hydraulic geometry of a section (area, top width, hydraulic radius, critical
 * depth) see `XSectionGeometry`.
 *
 * @license  Apache-2.0
 */

import { XSectShape } from "./enums.js";

/** Meaning of geom1..geom4 per shape; shorter tuples leave the trailing geoms unused. */
const GEOM_LABELS: Partial<Record<XSectShape, readonly string[]>> = {
  [XSectShape.CIRCULAR]: ["diameter"],
  [XSectShape.FILLED_CIRCULAR]: ["diameter", "filled_depth"],
  [XSectShape.RECT_CLOSED]: ["height", "width"],
  [XSectShape.RECT_OPEN]: ["height", "width", "sides_removed"],
  [XSectShape.TRAPEZOIDAL]: ["height", "bottom_width", "left_slope", "right_slope"],
  [XSectShape.TRIANGULAR]: ["height", "top_width"],
  [XSectShape.PARABOLIC]: ["height", "top_width"],
  [XSectShape.POWER]: ["height", "top_width", "exponent"],
  [XSectShape.MODBASKETHANDLE]: ["height", "bottom_width", "top_radius"],
  [XSectShape.EGGSHAPED]: ["height"],
  [XSectShape.HORSESHOE]: ["height"],
  [XSectShape.GOTHIC]: ["height"],
  [XSectShape.CATENARY]: ["height"],
  [XSectShape.SEMIELLIPTICAL]: ["height"],
  [XSectShape.BASKETHANDLE]: ["height"],
  [XSectShape.SEMICIRCULAR]: ["height"],
  [XSectShape.RECT_TRIANG]: ["height", "top_width", "triangle_height"],
  [XSectShape.RECT_ROUND]: ["height", "top_width", "bottom_radius"],
  [XSectShape.HORIZ_ELLIPSE]: ["height", "width"],
  [XSectShape.VERT_ELLIPSE]: ["height", "width"],
  [XSectShape.ARCH]: ["height", "width"],
  [XSectShape.IRREGULAR]: ["transect_index"],
  [XSectShape.CUSTOM]: ["height", "shape_curve_index"],
  [XSectShape.FORCE_MAIN]: ["diameter", "roughness"],
  [XSectShape.STREET_XSECT]: ["street_index"],
  [XSectShape.DUMMY]: [],
};

/** Cross-section shape and its four parameters, as a link reports them. */
export class CrossSection {
  /**
   * @param shape     Shape code ({@link XSectShape}).
   * @param shapeName Shape name, e.g. `"CIRCULAR"`.
   * @param geom1     First parameter (meaning depends on the shape).
   * @param geom2     Second parameter, or 0 when unused.
   * @param geom3     Third parameter, or 0 when unused.
   * @param geom4     Fourth parameter, or 0 when unused.
   */
  constructor(
    readonly shape: number,
    readonly shapeName: string,
    readonly geom1: number,
    readonly geom2: number,
    readonly geom3: number,
    readonly geom4: number,
  ) {
    Object.freeze(this);
  }

  /** Build from the raw `(shape, geom1..geom4)` the engine reports. */
  static fromRaw(
    shape: number,
    geom1: number,
    geom2: number,
    geom3: number,
    geom4: number,
  ): CrossSection {
    const name = (XSectShape as unknown as Record<number, string>)[shape] ?? `UNKNOWN(${shape})`;
    return new CrossSection(shape, name, geom1, geom2, geom3, geom4);
  }

  /** `{label: value}` for the parameters this shape uses, e.g. `{diameter: 1.2}`. */
  get geomLabels(): Record<string, number> {
    const labels = GEOM_LABELS[this.shape as XSectShape] ?? ["geom1", "geom2", "geom3", "geom4"];
    const values = [this.geom1, this.geom2, this.geom3, this.geom4];
    return Object.fromEntries(labels.map((label, i) => [label, values[i]]));
  }
}
