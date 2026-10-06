/**
 * End-to-end 2D smoke test against the compiled WASM module (Node).
 *
 * Requires: dist/openswmm_engine.js + .wasm (Emscripten build) and
 * dist/index.js (npm run build:ts).
 *
 *   npm run smoke
 *
 * Runs tests/fixtures/smoke2d.inp (the engine's examples/2d_complete_example.inp:
 * every [2D_*] section, two-way 1D coupling and all boundary types) through the
 * full lifecycle with `solver.surface2d`, writes the report to
 * tests/_work/smoke2d.wasm.rpt, and compares the 2D volume balance against the
 * native engine reference in tests/fixtures/smoke2d.native.rpt.
 *
 * The reference comes from a native build with the WASM build's arithmetic:
 * -DOPENSWMM_FORCE_SCALAR=ON, no OpenMP, -ffp-contract=off. WebAssembly has no
 * fused multiply-add, and on this small, stiff deck the marcher's adaptive
 * step turns FMA rounding into differences of about 2 % in the 2D volumes
 * against a default (AVX2/FMA) native build. Against the matching build the
 * reports agree to the printed digit; the 0.5 % tolerance only absorbs libm
 * and compiler-version noise.
 *
 * Skips (exit 0) when the module was built with -DOPENSWMM_WASM_2D=OFF.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const dist = resolve(root, "dist");
const work = resolve(root, "tests", "_work");

for (const f of ["openswmm_engine.js", "openswmm_engine.wasm", "index.js"]) {
  if (!existsSync(resolve(dist, f))) {
    console.error(`smoke2d: missing dist/${f} — run the Emscripten build and 'npm run build:ts' first`);
    process.exit(2);
  }
}

process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
function fail(err) {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(`smoke2d: FAIL — ${msg}`);
  if (err instanceof Error && err.stack) {
    const frames = err.stack.split("\n").slice(1).filter((l) => !/openswmm_engine\.js:1\b/.test(l) || l.length < 300);
    console.error(frames.slice(0, 12).join("\n"));
  }
  process.exit(1);
}

await main();

async function main() {
  const { default: createOpenSwmmModule } = await import(resolve(dist, "openswmm_engine.js"));
  const { Solver, EngineError, SurfaceBoundaryType } = await import(resolve(dist, "index.js"));

  const mod = await createOpenSwmmModule();
  if (typeof mod._swmm_2d_is_active !== "function") {
    console.log("smoke2d: skipped — module built without 2D (-DOPENSWMM_WASM_2D=OFF)");
    return;
  }

  const solver = new Solver(mod);
  solver.writeFile("/smoke2d.inp", readFileSync(resolve(root, "tests", "fixtures", "smoke2d.inp"), "utf8"));
  solver.open("/smoke2d.inp", "/smoke2d.rpt", "/smoke2d.out");
  const mesh = solver.surface2d;

  // The solver reads need initialize(); the mesh itself is parsed at open.
  let threw = false;
  try { mesh.getDepths(); } catch (e) { threw = e instanceof EngineError; }
  assert(threw, "getDepths() before initialize() did not throw an EngineError");

  solver.initialize();
  assert(mesh.isActive, "2D surface not active after initialize()");
  assert(mesh.nVertices === 9 && mesh.nTriangles === 8, `mesh size ${mesh.nVertices} vertices / ${mesh.nTriangles} cells`);
  assert(mesh.nQuads === 0 && mesh.edgeStride === 3, "unexpected quads or edge stride");
  assert(mesh.vertexCouplingCount === 1 && mesh.triangleCouplingCount === 1, "coupling counts");
  assert(mesh.getTriangleVertices(0).length === 3, "triangle connectivity");
  assert(Math.abs(mesh.getTriangleMannings(0) - 0.018) < 1e-12, "Manning's n of cell 0");
  const coords = mesh.getVertexCoords();
  assert(coords.x.length === 9 && coords.z.every(Number.isFinite), "vertex coordinates");
  assert(mesh.boundaryEdgeCount > 0, "no boundary edges");
  const bcTypes = new Set();
  for (let t = 0; t < mesh.nTriangles; t++) {
    const nb = mesh.getTriangleNeighbours(t);
    for (let e = 0; e < 3; e++) if (nb[e] < 0) bcTypes.add(mesh.getEdgeBcType(t, e));
  }
  assert(bcTypes.has(SurfaceBoundaryType.NORMAL_FLOW) && bcTypes.has(SurfaceBoundaryType.SPECIFIED_STAGE),
    `boundary types read back: ${[...bcTypes]}`);

  solver.start(true);
  let steps = 0;
  let peak = 0;
  while (solver.step() > 0) {
    steps++;
    peak = Math.max(peak, mesh.maxDepth);
  }
  const depths = mesh.getDepths();
  assert(depths.length === mesh.nTriangles, "depth array length");
  assert(depths.every((d) => Number.isFinite(d) && d >= 0), "non-finite or negative depth");
  assert(mesh.getEdgeFluxBulk().length === mesh.nTriangles * mesh.edgeStride, "edge flux array length");
  assert(mesh.getVertexHeads().length === mesh.nVertices, "vertex head array length");
  const stats = mesh.runStats;
  assert(/cpu/.test(stats.backend) && stats.steps > 0, `run stats ${JSON.stringify(stats)}`);
  const balance = mesh.getMassBalance();

  solver.end();
  solver.report();
  solver.close();
  const rpt = solver.readFile("/smoke2d.rpt", "utf8");
  solver.destroy();

  mkdirSync(work, { recursive: true });
  writeFileSync(resolve(work, "smoke2d.wasm.rpt"), rpt);

  // ---- The build has no HDF5 writer: OUTPUT_FILE is reported, not fatal ----
  assert(/OUTPUT_FILE \S+ ignored/.test(rpt), "report lacks the ignored-OUTPUT_FILE warning");

  // ---- Compare the 2D volume balance with the native reference ---------------
  const ref = readFileSync(resolve(root, "tests", "fixtures", "smoke2d.native.rpt"), "utf8");
  const rows = ["1D -> 2D Spill Inflow", "Boundary Inflow", "2D -> 1D Drain Outflow", "Boundary Outflow",
    "Final Stored Volume"];
  console.log(`smoke2d: ${steps} routing steps, ${stats.steps} marcher steps, peak depth ${peak.toFixed(3)} m`);
  for (const row of rows) {
    const a = surfaceRow(ref, row);
    const b = surfaceRow(rpt, row);
    console.log(`smoke2d: ${row.padEnd(24)} native=${a}  wasm=${b} m³`);
    assert(relDiff(a, b) < 0.005, `${row} differs >0.5%: ${a} vs ${b}`);
  }
  const ce = surfaceContinuity(rpt);
  console.log(`smoke2d: 2D continuity error (%) wasm=${ce}`);
  assert(Math.abs(ce) < 0.1, `2D continuity error too large: ${ce}%`);

  // ---- The API reads the same balance the report prints ----------------------
  assert(Math.abs(balance.finalStorage - surfaceRow(rpt, "Final Stored Volume")) < 0.01,
    `API final storage ${balance.finalStorage} vs report`);
  assert(Math.abs(balance.boundaryIn - surfaceRow(rpt, "Boundary Inflow")) < 0.01,
    `API boundary inflow ${balance.boundaryIn} vs report`);
  console.log("smoke2d: OK");
}

// ---- helpers ----------------------------------------------------------------
function assert(cond, msg) {
  if (!cond) {
    console.error(`smoke2d: FAIL — ${msg}`);
    process.exit(1);
  }
}
function relDiff(a, b) {
  return Math.abs(a - b) / Math.max(Math.abs(a), 1e-9);
}
function surfaceSection(text) {
  const i = text.indexOf("2D Surface Routing Continuity");
  assert(i >= 0, "no 2D Surface Routing Continuity section");
  return text.slice(i, text.indexOf("Continuity Error", i) + 80);
}
function surfaceRow(text, label) {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`${esc} \\.+\\s+(-?[\\d.]+)`).exec(surfaceSection(text));
  assert(m, `no 2D row "${label}"`);
  return Number(m[1]);
}
function surfaceContinuity(text) {
  const m = /Continuity Error \(%\) \.+\s+(-?[\d.]+)/.exec(surfaceSection(text));
  assert(m, "no 2D continuity error");
  return Number(m[1]);
}
