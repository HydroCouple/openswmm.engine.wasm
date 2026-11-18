/**
 * @file capabilities.ts
 * @brief What this engine build can do, as JSON-ready data (Python
 *        `openswmm.engine.capabilities`).
 *
 * The document has the same keys as Python's (`catalog_revision`,
 * `hdf5_2d_output`, ...), so a server can publish either unchanged.
 *
 * @license  Apache-2.0
 */

import * as catalog from "./catalog.js";
import { Output2DReader } from "./Output2D.js";
import { ProcessComponents } from "./ProcessComponents.js";
import { Solver } from "./Solver.js";
import { threadInfo } from "./Transport.js";
import type { OpenSwmmWasmModule } from "./types.js";
import { VERSION } from "./version.js";

/** Checkpoint capability bits by name (Python `CHECKPOINT_FEATURES`). */
export const CHECKPOINT_FEATURES: Readonly<Record<string, number>> = {
  inspection: 1 << 0,
  restore: 1 << 1,
  save_new: 1 << 2,
  binary_profile: 1 << 3,
  surface_profile: 1 << 4,
  source_stream: 1 << 5,
  file_profile: 1 << 6,
  bundle_export: 1 << 7,
  session_builder: 1 << 8,
};

/** The build description {@link capabilities} returns. */
export interface Capabilities {
  version: string;
  catalog_revision: number;
  c_exports: unknown;
  features: { "2d": boolean; geopackage: boolean; hdf5_2d_output: boolean };
  threads: {
    logical_cpus: number;
    omp_max_threads: number;
    omp_available: boolean;
    perf_cores: number;
    kokkos_omp_threads: number;
  };
  checkpoints: string[];
  process_components: string[];
  component_libraries: { id: string; kind: string; version: string; loaded: boolean }[];
}

/**
 * Describe this build: version, catalog revision, optional features,
 * threads, checkpoint support and process components. The values describe
 * the build, not a model.
 */
export function capabilities(mod: OpenSwmmWasmModule): Capabilities {
  const exported = (name: string) =>
    typeof (mod as unknown as Record<string, unknown>)[`_${name}`] === "function";
  const solver = new Solver(mod);
  let flags = 0;
  try {
    flags = solver.checkpoints.capabilities;
  } finally {
    solver.destroy();
  }
  const t = threadInfo(mod);
  return {
    version: VERSION,
    catalog_revision: catalog.revision(),
    c_exports: catalog.load().c_exports,
    features: {
      "2d": exported("swmm_2d_cell_count"),
      geopackage: exported("swmm_gpkg_open"),
      hdf5_2d_output: Output2DReader.available(mod),
    },
    threads: {
      logical_cpus: t.logicalCpus,
      omp_max_threads: t.ompMaxThreads,
      omp_available: t.ompAvailable,
      perf_cores: t.perfCores,
      kokkos_omp_threads: t.kokkosOmpThreads,
    },
    checkpoints: Object.entries(CHECKPOINT_FEATURES)
      .filter(([, bit]) => flags & bit)
      .map(([name]) => name),
    process_components: ProcessComponents.known(mod)
      .filter((c) => c.implemented)
      .map((c) => c.id),
    component_libraries: ProcessComponents.libraries(mod).map((lib) => ({
      id: lib.id,
      kind: lib.kind,
      version: lib.version,
      loaded: !lib.loadError,
    })),
  };
}
