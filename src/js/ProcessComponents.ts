/**
 * @file ProcessComponents.ts
 * @brief `solver.processComponents`: the `[PROCESS_COMPONENTS]` registration
 *        table (Python `openswmm.engine._process_components`).
 *
 * Each registration carries an id, the `config="…"` argument as written
 * (possibly empty) and the path the config was read from at the last open
 * (`""` until resolved). A config file need not exist when registering.
 * Removal shifts every later index down. Rows are snapshots.
 *
 * @license  Apache-2.0
 */

import { BadHandleError, ElementNotFoundError, raiseForCode } from "./errors.js";
import { checkedAlloc, rawOf, withCStrings } from "./mem.js";
import { readStruct, withStruct } from "./structs.js";
import type { OpenSwmmWasmModule } from "./types.js";
import { SolverView } from "./view.js";

/** One `[PROCESS_COMPONENTS]` registration. */
export interface ProcessComponent {
  /** Registration index; not stable across removals. */
  readonly componentIndex: number;
  readonly id: string;
  /** The `config="…"` argument as written (`""` for none). */
  readonly config: string;
  /** The path the config was read from at the last open (`""` until resolved). */
  readonly resolved: string;
}

/** A built-in component id, independent of model registrations. */
export interface KnownProcessComponent {
  readonly id: string;
  readonly description: string;
  readonly implemented: boolean;
}

/** A HydroCouple component library the engine discovered. */
export interface ComponentLibrary {
  /** `""` when the library was refused. */
  readonly id: string;
  readonly caption: string;
  readonly version: string;
  readonly path: string;
  /** `"model"` or `"other"`; `""` when refused. */
  readonly kind: string;
  readonly stamp: string;
  /** `""` when loaded; otherwise why it was refused. */
  readonly loadError: string;
}

/** `solver.processComponents`: rows addressable by index or id. */
export class ProcessComponents extends SolverView {
  /** The built-in component vocabulary, unimplemented placeholders included. */
  static known(mod: OpenSwmmWasmModule): KnownProcessComponent[] {
    const raw = rawOf(mod);
    const flag = checkedAlloc(mod, 4);
    try {
      return Array.from({ length: raw.swmm_process_component_known_count() }, (_, i) => {
        mod.HEAP32[flag >> 2] = 0;
        const [id, description] = withCStrings(mod, 4096, 2, ([a, b], len) =>
          raw.swmm_process_component_known_get(i, a, len, b, len, flag),
        );
        return { id, description, implemented: mod.HEAP32[flag >> 2] !== 0 };
      });
    } finally {
      mod._free(flag);
    }
  }

  /**
   * HydroCouple component libraries on the search path, refused ones
   * included. Empty in this build (no HydroCouple support in WASM).
   */
  static libraries(mod: OpenSwmmWasmModule): ComponentLibrary[] {
    const raw = rawOf(mod);
    return Array.from({ length: raw.swmm_component_library_count() }, (_, i) =>
      withStruct(mod, "SWMM_ComponentLibraryInfo", (p) => {
        raiseForCode(raw.swmm_component_library_get(i, p));
        const r = readStruct(mod, "SWMM_ComponentLibraryInfo", p) as Record<string, string>;
        return {
          id: r.id,
          caption: r.caption,
          version: r.version,
          path: r.path,
          kind: r.kind,
          stamp: r.stamp,
          loadError: r.load_error,
        };
      }),
    );
  }

  /**
   * Scan a directory for component libraries and keep it for later discovery.
   *
   * @throws {@link PluginError} in this build (no HydroCouple support).
   */
  static addSearchPath(mod: OpenSwmmWasmModule, directory: string): void {
    raiseForCode(rawOf(mod).swmm_component_search_path_add(directory));
  }

  get length(): number {
    const n = this._raw.swmm_process_component_count(this._h);
    if (n < 0) throw new BadHandleError("Invalid engine handle reading [PROCESS_COMPONENTS] count");
    return n;
  }

  *[Symbol.iterator](): Iterator<ProcessComponent> {
    const n = this.length;
    for (let i = 0; i < n; i++) yield this._get(i);
  }

  /** One registration by index (negative counts from the end) or id. */
  get(key: number | string): ProcessComponent {
    return this._get(this._indexOf(key));
  }

  /** Whether a component with this id is registered. */
  has(componentId: string): boolean {
    if (typeof componentId !== "string") return false;
    return this._raw.swmm_process_component_find(this._h, componentId) >= 0;
  }

  /** Registration index of an id (valid until the next removal). */
  getIndex(componentId: string): number {
    const i = this._raw.swmm_process_component_find(this._h, componentId);
    if (i < 0)
      throw new ElementNotFoundError(componentId, `Process component '${componentId}' not found`);
    return i;
  }

  /**
   * Register a component (BUILDING/OPENED); the config path need not exist
   * yet. A duplicate id is refused. Returns the new row.
   */
  register(componentId: string, configPath = ""): ProcessComponent {
    raiseForCode(this._raw.swmm_process_component_register(this._h, componentId, configPath));
    this._solver._bumpGeneration();
    return this._get(this.getIndex(componentId));
  }

  /** Remove a registration; later indices shift down. The config file stays. */
  remove(key: number | string): void {
    const idx = this._indexOf(key);
    raiseForCode(this._raw.swmm_process_component_remove(this._h, idx));
    this._solver._bumpGeneration();
  }

  /** The row's extra `[name, value]` arguments, in authored order, duplicates kept. */
  arguments(key: number | string): [string, string][] {
    const idx = this._indexOf(key);
    const h = this._h;
    const count = this._raw.swmm_process_component_argument_count(h, idx);
    if (count < 0) throw new BadHandleError("Cannot read component arguments");
    return Array.from({ length: count }, (_, a) => {
      const [name, value] = withCStrings(this._mod, 256, 2, ([n, v], len) =>
        this._raw.swmm_process_component_argument_get(h, idx, a, n, len, v, len),
      );
      return [name, value];
    });
  }

  /** Set an authored extra argument; `null` removes it (BUILDING/OPENED). */
  setArgument(key: number | string, name: string, value: string | null): void {
    const idx = this._indexOf(key);
    if (name.includes("\0")) throw new RangeError("Component argument names cannot contain NUL");
    if (value !== null && typeof value !== "string") {
      throw new TypeError("Component argument values must be strings or null");
    }
    if (value?.includes("\0")) throw new RangeError("Component argument values cannot contain NUL");
    raiseForCode(this._raw.swmm_process_component_argument_set(this._h, idx, name, value));
    this._solver._bumpGeneration();
  }

  /** @internal */
  private _indexOf(key: number | string): number {
    if (typeof key === "string") return this.getIndex(key);
    if (typeof key !== "number" || !Number.isInteger(key)) {
      throw new TypeError(`Process component key must be int or str, got ${typeof key}`);
    }
    const n = this.length;
    const i = key < 0 ? key + n : key;
    if (!(i >= 0 && i < n)) throw new RangeError(String(key));
    return i;
  }

  /** @internal */
  private _get(idx: number): ProcessComponent {
    const [id, config, resolved] = withCStrings(this._mod, 512, 3, ([a, b, c], len) =>
      this._raw.swmm_process_component_get(this._h, idx, a, len, b, len, c, len),
    );
    return { componentIndex: idx, id, config, resolved };
  }
}
