/**
 * HDF5 smoke test against the compiled WASM module (Node).
 *
 *   node tests/smoke/hdf5.mjs        (run by `npm run smoke`)
 *
 * 1. The module reports the 2D results reader as available.
 * 2. tests/fixtures/smoke2d.inp writes its [2D_OPTIONS] OUTPUT_FILE; the file is
 *    read back through swmm_output2d_* and its last depth record must equal the
 *    live Surface2D depths at the end of the run.
 * 3. tests/fixtures/smoke.inp saves as an .h5 model (an HDF5 file).
 *
 * Writes tests/_work/hdf5/: smoke2d.wasm.h5 (for a native cross-read),
 * smoke2d.datasets.txt and hdf5.json (the compared values).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const dist = resolve(root, "dist");
const work = resolve(root, "tests", "_work", "hdf5");
const HDF5_MODEL_PLUGIN = "org.hydrocouple.openswmm.plugins.hdf5";

for (const f of ["openswmm_engine.js", "openswmm_engine.wasm", "index.js", "raw.js", "mem.js"]) {
  if (!existsSync(resolve(dist, f))) {
    console.error(`hdf5: missing dist/${f} — run the Emscripten build and 'npm run build' first`);
    process.exit(2);
  }
}
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
function fail(err) {
  console.error(`hdf5: FAIL — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const { default: createOpenSwmmModule } = await import(resolve(dist, "openswmm_engine.js"));
const { Solver, raiseForCode } = await import(resolve(dist, "index.js"));
const { bindRaw } = await import(resolve(dist, "raw.js"));
const { checkedAlloc } = await import(resolve(dist, "mem.js"));
mkdirSync(work, { recursive: true });

const mod = await createOpenSwmmModule();
const api = bindRaw(mod);
const evidence = {};

// ---- 1. availability ---------------------------------------------------------
assert(api.swmm_output2d_available() === 1, "module was built without the 2D HDF5 results reader");

// ---- 2. 2D results file --------------------------------------------------------
const solver = new Solver(mod);
solver.writeFile("/smoke2d.inp", readFileSync(resolve(root, "tests/fixtures/smoke2d.inp"), "utf8"));
solver.open("/smoke2d.inp", "/smoke2d.rpt", "/smoke2d.out");
solver.initialize();
solver.start(true);
while (solver.step() > 0);
const liveDepths = Array.from(solver.surface2d.getDepths());
solver.end();
solver.report();
solver.close();
const rpt = solver.readFile("/smoke2d.rpt", "utf8");
assert(!/OUTPUT_FILE .* ignored/.test(rpt), "the engine still ignores OUTPUT_FILE");
const h5Path = "/2d_complete_example.h5";
assert(mod.FS.analyzePath(h5Path).exists, `the run wrote no ${h5Path}`);
const h5Bytes = mod.FS.readFile(h5Path);
writeFileSync(resolve(work, "smoke2d.wasm.h5"), h5Bytes);
solver.destroy();

/** Call a (buffer, capacity, size_t* required) text getter twice: size, then copy. */
function readText(call) {
  const req = checkedAlloc(mod, 4);
  try {
    raiseForCode(call(0, 0, req), api.swmm_output2d_error());
    const n = mod.HEAPU32[req >> 2];
    const buf = checkedAlloc(mod, n);
    try {
      raiseForCode(call(buf, n, req), api.swmm_output2d_error());
      return mod.UTF8ToString(buf, n);
    } finally {
      mod._free(buf);
    }
  } finally {
    mod._free(req);
  }
}

const out = checkedAlloc(mod, 4);
raiseForCode(api.swmm_output2d_open(h5Path, out), api.swmm_output2d_error());
const reader = mod.HEAPU32[out >> 2];
mod._free(out);
try {
  const datasets = readText((buf, cap, req) => api.swmm_output2d_datasets(reader, buf, cap, req))
    .split("\n")
    .filter(Boolean);
  writeFileSync(resolve(work, "smoke2d.datasets.txt"), datasets.join("\n") + "\n");

  const shapeOf = (name) => {
    const p = checkedAlloc(mod, 4 * 3 + 8 * 8 + 8);
    try {
      const rank = p,
        integer = p + 4,
        dims = p + 8,
        unlimited = p + 8 + 64;
      raiseForCode(api.swmm_output2d_shape(reader, name, rank, dims, integer, unlimited));
      const r = mod.HEAP32[rank >> 2];
      return {
        dims: Array.from({ length: r }, (_, i) => mod.HEAPU32[(dims >> 2) + 2 * i]),
        integer: mod.HEAP32[integer >> 2],
      };
    } finally {
      mod._free(p);
    }
  };
  const cells = liveDepths.length;
  // UGRID naming: <mesh>_face_depth, one row per output time, one column per cell.
  const depthName = datasets.find((d) => /^\/\w+_face_depth$/.test(d));
  assert(depthName, `no <mesh>_face_depth dataset among: ${datasets.join(", ")}`);
  const { dims, integer } = shapeOf(depthName);
  assert(
    integer === 0 && dims.length === 2 && dims[1] === cells,
    `${depthName} is not [time, ${cells} cells] floating point: ${dims.join("x")}`,
  );
  const last = dims[0] - 1;

  const sel = checkedAlloc(mod, 8 * 6);
  const values = checkedAlloc(mod, 8 * cells);
  try {
    const u64 = (slot, v) => {
      mod.HEAPU32[(sel >> 2) + 2 * slot] = v;
      mod.HEAPU32[(sel >> 2) + 2 * slot + 1] = 0;
    };
    u64(0, last);
    u64(1, 0); // start
    u64(2, 1);
    u64(3, cells); // count
    u64(4, 1);
    u64(5, 1); // stride
    raiseForCode(
      api.swmm_output2d_read_double(reader, depthName, sel, sel + 16, sel + 32, values, cells),
      api.swmm_output2d_error(),
    );
    const fileDepths = Array.from(mod.HEAPF64.subarray(values >> 3, (values >> 3) + cells));
    const maxDiff = Math.max(...fileDepths.map((v, i) => Math.abs(v - liveDepths[i])));
    evidence.results = { dataset: depthName, shape: dims, liveDepths, fileDepths, maxDiff };
    console.log(
      `hdf5: ${depthName} ${dims.join("x")}, last record vs live depths max |diff| ${maxDiff}`,
    );
    assert(
      maxDiff <= 1e-6 * Math.max(1, ...liveDepths),
      `results file differs from live depths by ${maxDiff}`,
    );
  } finally {
    mod._free(sel);
    mod._free(values);
  }
} finally {
  api.swmm_output2d_close(reader);
}

// ---- 3. .h5 model ---------------------------------------------------------------
// Save the model as .h5, reopen it with the HDF5 input plugin named (the
// built-in .inp reader would parse the file as text), and run both to the end.
/** Run a model to the end; returns the final depth of every node. */
function runToEnd(path, plugin = "") {
  const s = new Solver(mod);
  try {
    s.open(path, "/roundtrip.rpt", "/roundtrip.out", plugin);
    s.initialize();
    s.start(false);
    while (s.step() > 0);
    const depths = Array.from({ length: s.nodes.length }, (_, i) => s.nodes.get(i).depth);
    s.end();
    return depths;
  } finally {
    s.destroy();
  }
}
{
  const s = new Solver(mod);
  s.writeFile("/smoke.inp", readFileSync(resolve(root, "tests/fixtures/smoke.inp"), "utf8"));
  s.open("/smoke.inp", "/smoke.rpt", "/smoke.out");
  s.writeModel("/smoke-model.h5", HDF5_MODEL_PLUGIN);
  s.close();
  s.destroy();
}
const model = mod.FS.readFile("/smoke-model.h5");
writeFileSync(resolve(work, "smoke-model.wasm.h5"), model);
const signature = Array.from(model.subarray(0, 8));
evidence.model = { bytes: model.length, signature };
console.log(`hdf5: .h5 model written, ${model.length} bytes`);
assert(
  signature.join(",") === [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a].join(","),
  "the .h5 model is not an HDF5 file",
);
const fromInp = runToEnd("/smoke.inp");
const fromH5 = runToEnd("/smoke-model.h5", HDF5_MODEL_PLUGIN);
evidence.model.finalDepths = { inp: fromInp, h5: fromH5 };
assert(
  fromInp.length > 0 &&
    fromH5.length === fromInp.length &&
    fromH5.every((d, i) => d === fromInp[i]),
  `the reopened .h5 model ran differently: ${fromH5} vs ${fromInp}`,
);
console.log(
  `hdf5: .h5 model reopened with its plugin and ran like the .inp (${fromH5.length} nodes)`,
);

writeFileSync(resolve(work, "hdf5.json"), JSON.stringify(evidence, null, 1) + "\n");
console.log("hdf5: OK");
