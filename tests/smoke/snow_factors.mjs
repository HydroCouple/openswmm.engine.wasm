/** Verify the two rain-gage multipliers independently against real snowfall. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { default: createOpenSwmmModule } = await import(resolve(root, "dist/openswmm_engine.js"));
const { Solver } = await import(resolve(root, "dist/index.js"));
const mod = await createOpenSwmmModule();
const deck = readFileSync(
  resolve(root, "extern/openswmm.engine/tests/parity/snow/snow_parity.inp"),
  "utf8",
);
mod.FS.writeFile("/snow-factors.inp", deck);

function precipitation(report) {
  const row = /Total Precipitation \.{6,}\s+([\d.]+)/.exec(report);
  if (!row) throw new Error("Runoff continuity report lacks total precipitation");
  return Number(row[1]);
}

function run(rainScale, snowFactor, save = false) {
  const tag = `${rainScale}-${snowFactor}`;
  const solver = new Solver(mod);
  try {
    solver.open("/snow-factors.inp", `/${tag}.rpt`, `/${tag}.out`);
    const gage = solver.gages.get("RG1");
    gage.scaleFactor = rainScale;
    gage.snowFactor = snowFactor;
    if (save) {
      solver.writeModel("/snow-factors-edited.inp");
    }
    solver.initialize();
    solver.start(true);
    while (solver.step() > 0) {
      /* finish */
    }
    solver.end();
    solver.report();
    return precipitation(solver.readFile(`/${tag}.rpt`, "utf8"));
  } finally {
    solver.destroy();
  }
}

const expected = [
  [1, 1, 20],
  [10, 1, 200],
  [1, 1.4, 24.8],
  [10, 1.4, 248],
  [10, 10, 1280],
];
for (const [rainScale, snowFactor, expectedPrecipitation] of expected) {
  const actual = run(rainScale, snowFactor, rainScale === 10 && snowFactor === 10);
  if (Math.abs(actual - expectedPrecipitation) > 0.001) {
    throw new Error(
      `Precipitation with factors ${rainScale}/${snowFactor}: expected ${expectedPrecipitation}, got ${actual}`,
    );
  }
}

const saved = new Solver(mod);
try {
  saved.open("/snow-factors-edited.inp", "/saved-snow.rpt", "/saved-snow.out");
  const gage = saved.gages.get("RG1");
  if (gage.scaleFactor !== 10 || gage.snowFactor !== 10) {
    throw new Error("Rain and snow factors did not survive model save/reopen");
  }
  saved.initialize();
  saved.start(true);
  while (saved.step() > 0) {
    /* finish */
  }
  saved.end();
  saved.report();
  const total = precipitation(saved.readFile("/saved-snow.rpt", "utf8"));
  if (Math.abs(total - 1280) > 0.001) {
    throw new Error(`Saved snow model produced ${total} instead of 1280 total precipitation`);
  }
} finally {
  saved.destroy();
}

console.log("snow_factors: independent effects and 10×/10× save/reopen verified");
