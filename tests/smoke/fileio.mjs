/** Real WebAssembly model save/reopen and rain-gage effect regression. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { default: createOpenSwmmModule } = await import(resolve(root, "dist/openswmm_engine.js"));
const { ModelBuilder, Solver } = await import(resolve(root, "dist/index.js"));
const mod = await createOpenSwmmModule();
const fixture = readFileSync(resolve(root, "tests/fixtures/smoke.inp"), "utf8");
mod.FS.writeFile("/gage-original.inp", fixture);

const controlAuthor = new Solver(mod);
try {
  controlAuthor.open("/gage-original.inp", "/control.rpt", "/control.out");
  const rule =
    "RULE LONG\nIF NODE J1 DEPTH > 1\nTHEN LINK C1 STATUS = CLOSED\n;" + "雪".repeat(5000);
  controlAuthor.controls.addRule(rule);
  const read = controlAuthor.controls.get(controlAuthor.controls.length - 1);
  if (read.id !== "LONG" || read.text !== rule) {
    throw new Error("Long control rule was truncated by the binding");
  }
} finally {
  controlAuthor.destroy();
}

const builder = new ModelBuilder(mod);
try {
  const title = "Rainfall ☔ 雪 " + "á".repeat(5000);
  const args = "config=" + "x".repeat(6000);
  builder.addTitleLine(title);
  builder.pluginSet("example-plugin", args);
  if (builder.getTitleLine(0) !== title || builder.pluginGet(0).args !== args) {
    throw new Error("Long authored text was truncated by the binding");
  }
  builder.write("/long-text.inp");
  const saved = mod.FS.readFile("/long-text.inp", { encoding: "utf8" });
  if (!saved.includes(title) || !saved.includes(args)) {
    throw new Error("Long authored text was truncated by the model writer");
  }
} finally {
  builder[Symbol.dispose]();
}

const author = new Solver(mod);
try {
  author.open("/gage-original.inp", "/author.rpt", "/author.out");
  const gage = author.gages.get("G1");
  gage.scaleFactor = 10;
  gage.snowFactor = 1.4;
  author.writeModel("/gage-edited.inp");
  const saved = author.readFile("/gage-edited.inp", "utf8");
  if (!saved.includes("G1")) throw new Error("Saved model lost the rain gage");
} finally {
  author.destroy();
}

const reopened = new Solver(mod);
try {
  reopened.open("/gage-edited.inp", "/reopened.rpt", "/reopened.out");
  const gage = reopened.gages.get("G1");
  if (gage.scaleFactor !== 10 || Math.abs(gage.snowFactor - 1.4) > 1e-12) {
    throw new Error(
      `Rain-gage factors did not survive save/reopen: ${gage.scaleFactor}, ${gage.snowFactor}`,
    );
  }
} finally {
  reopened.destroy();
}

function outfallPeak(report) {
  const section = report.slice(report.indexOf("Outfall Loading Summary"));
  const match = /^\s*O1\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/m.exec(section);
  if (!match) throw new Error("Outfall peak missing from report");
  return Number(match[3]);
}

function simulate(input, name) {
  const solver = new Solver(mod);
  try {
    solver.open(input, `/${name}.rpt`, `/${name}.out`);
    solver.initialize();
    solver.start(true);
    while (solver.step() > 0) {
      /* finish */
    }
    solver.end();
    solver.report();
    const report = solver.readFile(`/${name}.rpt`, "utf8");
    solver.close();
    return outfallPeak(report);
  } finally {
    solver.destroy();
  }
}

const baseline = simulate("/gage-original.inp", "baseline");
const scaled = simulate("/gage-edited.inp", "scaled");
if (!(scaled > baseline * 1.1)) {
  throw new Error(`Rainfall scale had no material effect: baseline=${baseline}, scaled=${scaled}`);
}
console.log(`fileio: factors survive save/reopen; outfall peak ${baseline} → ${scaled}`);
