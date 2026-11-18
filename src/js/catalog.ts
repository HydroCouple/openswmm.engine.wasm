/**
 * @file catalog.ts
 * @brief Machine-readable map of the engine API (Python
 *        `openswmm.engine.catalog`).
 *
 * The catalog lists every target reachable from a solver (services such as
 * `forcing` and `surface2d.groundwater`, element kinds such as `node` and
 * their sub-views such as `node.stats`) and every property and method on
 * them, with type, access, units, lifecycle phases and wrapped C symbols.
 * Paths are the Python names (`node.stats.max_depth`), the same paths
 * {@link Fields} uses; {@link resolve} walks them on a TypeScript solver.
 *
 * ```ts
 * import { catalog } from "@hydrocouple/openswmm-engine-wasm";
 * catalog.lookup("node.stats.max_depth").units;   // "length"
 * catalog.resolve(solver, "node.stats", "J1");     // the live NodeStats view
 * ```
 *
 * {@link revision} increases whenever a path is renamed or removed; renamed
 * paths keep working with a one-time console warning, removed ones fail with
 * the reason.
 *
 * @license  Apache-2.0
 */

import { CATALOG_JSON } from "./catalog.generated.js";
import { ElementNotFoundError } from "./errors.js";
import { FlowUnits } from "./enums.js";

/** A catalog entry (target or member); fields as in `catalog.json`. */
export type CatalogEntry = Record<string, unknown> & { path: string };

/** The whole catalog. */
export interface Catalog {
  schema: number;
  revision: number;
  renamed: Record<string, string>;
  removed: Record<string, string>;
  targets: Record<string, CatalogEntry>;
  members: (CatalogEntry & { target: string; name: string })[];
  [key: string]: unknown;
}

let cached: Catalog | null = null;
let byPath: Map<string, CatalogEntry> | null = null;
let views: Record<string, string> | null = null;
const warned = new Set<string>();

/** The whole catalog (parsed once and cached). */
export function load(): Catalog {
  return (cached ??= JSON.parse(CATALOG_JSON) as Catalog);
}

/** Catalog revision; it increases whenever a path is renamed or removed. */
export function revision(): number {
  return Number(load().revision ?? 1);
}

/** Throw when the catalog is older than `minimum`. */
export function requireRevision(minimum: number, consumer = "this package"): void {
  if (revision() < minimum) {
    throw new Error(
      `${consumer} needs openswmm engine catalog revision ${minimum} or newer; the ` +
        `installed openswmm has revision ${revision()}. Upgrade or rebuild openswmm.`,
    );
  }
}

/** `path` with its longest renamed prefix replaced, or `null` when none applies. */
export function renamedPath(
  path: string,
  renamed: Readonly<Record<string, string>>,
): string | null {
  let best: string | null = null;
  for (const old of Object.keys(renamed)) {
    if (
      (path === old || path.startsWith(old + ".")) &&
      (best === null || old.length > best.length)
    ) {
      best = old;
    }
  }
  return best === null ? null : renamed[best] + path.slice(best.length);
}

/** Object-valued properties that expose another target: `{ path: viewTarget }`. */
export function viewsOf(catalog: Catalog): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of catalog.members) {
    if (typeof m.view_target === "string") out[m.path] = m.view_target;
  }
  return out;
}

/**
 * Spell `path` against `catalog`: `[current path, whether a rename applied]`.
 * Renamed prefixes are replaced first; then a prefix that is a shared view
 * (`surface2d.groundwater` exposes `groundwater2d`) becomes its target.
 */
export function currentPath(
  path: string,
  catalog: Catalog,
  viewMap: Readonly<Record<string, string>> | null = null,
): [string, boolean] {
  const renamed = renamedPath(path, catalog.renamed ?? {});
  const wasRenamed = renamed !== null;
  let current = renamed ?? path;
  const shared = viewMap ?? viewsOf(catalog);
  for (let pass = 0; pass < 8; pass++) {
    // Views can chain (coupling.groundwater -> coupling.surface).
    const parts = current.split(".");
    let replaced = false;
    for (let i = parts.length; i > 0; i--) {
      const target = shared[parts.slice(0, i).join(".")];
      if (target !== undefined) {
        const rest = parts.slice(i).join(".");
        current = rest ? (target === "solver" ? rest : `${target}.${rest}`) : target;
        replaced = true;
        break;
      }
    }
    if (!replaced) break;
  }
  return [current, wasRenamed];
}

/** The current spelling of a target or member path (renamed paths warn once each). */
export function canonical(path: string): string {
  views ??= viewsOf(load());
  const [current, wasRenamed] = currentPath(path, load(), views);
  if (wasRenamed && !warned.has(path)) {
    warned.add(path);
    console.warn(`engine catalog path '${path}' is now '${current}'`);
  }
  return current;
}

function removedReason(path: string): string | null {
  for (const [prefix, reason] of Object.entries(load().removed ?? {})) {
    if (path === prefix || path.startsWith(prefix + ".")) return String(reason);
  }
  return null;
}

/** `{ target name: entry }`; element targets carry `collection` and `key`. */
export function targets(): Record<string, CatalogEntry> {
  return load().targets;
}

/** Members of one target, or of every target. */
export function members(target: string | null = null): Catalog["members"] {
  let name = target;
  if (name !== null && !(name in targets())) name = canonical(name);
  return load().members.filter((m) => name === null || m.target === name);
}

/**
 * The member entry of a dotted path such as `"node.depth"`.
 *
 * @throws {@link ElementNotFoundError} if the path is not in the catalog.
 */
export function lookup(path: string): CatalogEntry {
  byPath ??= new Map(load().members.map((m) => [m.path, m]));
  const entry = byPath.get(path) ?? byPath.get(canonical(path));
  if (entry) return entry;
  const reason = removedReason(path);
  throw new ElementNotFoundError(
    path,
    `'${path}' is not in the engine catalog${reason ? ` (removed: ${reason})` : ""}`,
  );
}

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/**
 * The live object behind `target` on `solver`. Element targets (`node`,
 * `link.pump`, ...) need the element `key` (id or index). Python attribute
 * names are spelled in camelCase. Standalone roots (`builder`, `output`, ...)
 * are not reachable from a solver.
 */
export function resolve(
  solver: object,
  target: string,
  key: number | string | null = null,
): unknown {
  let name = target;
  if (!(name in targets())) name = canonical(name);
  const entry = targets()[name];
  if (!entry) throw new ElementNotFoundError(target, `'${target}' is not a catalog target`);
  if ("construct" in entry) {
    throw new ElementNotFoundError(
      target,
      `'${target}' is a standalone root; construct it directly`,
    );
  }
  let obj: unknown = solver;
  for (const part of String(entry.path).split(".").filter(Boolean)) {
    const element = part.endsWith("[]");
    const prop = camel(element ? part.slice(0, -2) : part);
    const next = (obj as Record<string, unknown>)[prop];
    if (next === undefined) {
      throw new ElementNotFoundError(target, `'${target}': no '${prop}' on ${String(obj)}`);
    }
    if (element) {
      if (key === null)
        throw new RangeError(`'${target}' is an element target; pass its id or index`);
      obj = (next as { get(k: number | string): unknown }).get(key);
    } else {
      obj = next;
    }
  }
  return obj;
}

const FIXED: Record<string, string> = {
  dimensionless: "dimensionless",
  fraction: "fraction",
  percent: "%",
  count: "count",
  manning_n: "Manning's n",
  concentration: "pollutant concentration units",
  user_defined: "units implied by the model's expressions",
  shape_dependent: "depends on the cross-section shape (see xsect.shape)",
  unverified: "stored as given; the engine applies no unit conversion",
  datetime: "DateTime (decimal days)",
};

const BY_SYSTEM: Record<string, [string, string]> = {
  length: ["ft", "m"],
  area: ["ft2", "m2"],
  land_area: ["ac", "ha"],
  volume: ["ft3", "m3"],
  velocity: ["ft/s", "m/s"],
  rain_rate: ["in/hr", "mm/hr"],
  rain_depth: ["in", "mm"],
  evap_rate: ["in/day", "mm/day"],
  temperature: ["degF", "degC"],
  user_temperature: ["degF", "degC"],
  wind_speed: ["mph", "km/hr"],
  "length2/s": ["ft2/s", "m2/s"],
  weir_coeff: ["ft^0.5/s", "m^0.5/s"],
  section_factor: ["ft^8/3", "m^8/3"],
};

/** Every symbolic unit kind; any other `units` value is a literal unit (`"m3/s"`). */
export const UNIT_KINDS: ReadonlySet<string> = new Set([
  ...Object.keys(FIXED),
  ...Object.keys(BY_SYSTEM),
  "flow",
]);

/**
 * Readable units of a catalog unit kind in a model's unit system. `flow`
 * takes the model's flow units (a token such as `"CFS"` or a
 * {@link FlowUnits} value); other system-dependent kinds take `"US"` or
 * `"SI"` and come back unchanged without one; literal units pass through.
 */
export function unitLabel(
  kind: string | null,
  unitSystem: "US" | "SI" | null = null,
  flowUnits: FlowUnits | string | null = null,
): string | null {
  if (kind === null || kind === "" || kind in FIXED) return kind ? FIXED[kind] : null;
  if (kind === "flow") {
    if (flowUnits === null || flowUnits === "") return kind;
    return typeof flowUnits === "number" ? (FlowUnits[flowUnits] ?? String(flowUnits)) : flowUnits;
  }
  if (kind in BY_SYSTEM && (unitSystem === "US" || unitSystem === "SI")) {
    return BY_SYSTEM[kind][unitSystem === "SI" ? 1 : 0];
  }
  return kind;
}
