/**
 * Checkpoint continuation with binary output in the module's in-memory file system, which has
 * no hard links: a session saves at mid-run, a fresh session restores it and finishes, and the
 * finished .out must equal the uninterrupted session's.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { default: createOpenSwmmModule } = await import(resolve(root, "dist/openswmm_engine.js"));
const { Solver } = await import(resolve(root, "dist/index.js"));
const mod = await createOpenSwmmModule();
mod.FS.writeFile("/checkpoint.inp", readFileSync(resolve(root, "tests/fixtures/smoke.inp"), "utf8"));

const BINARY = 1;
/** Run a checkpoint session; save at `saveAt` seconds and stop, or restore `restore` first. */
function session(name, { saveAt = 0, restore = "" } = {}) {
  const solver = new Solver(mod);
  try {
    solver.open("/checkpoint.inp", `/${name}.rpt`, `/${name}.out`);
    solver.checkpoints.startSession(BINARY);
    if (restore) solver.checkpoints.restore(restore);
    let t;
    while ((t = solver.step()) > 0) {
      if (saveAt && t >= saveAt) {
        solver.checkpoints.save(`/${name}.ckpt`);
        return { checkpoint: `/${name}.ckpt`, at: t };
      }
    }
    solver.end();
    solver.report();
    solver.close();
    return { out: mod.FS.readFile(`/${name}.out`) };
  } finally {
    solver.destroy();
  }
}

const probe = new Solver(mod);
probe.open("/checkpoint.inp", "/probe.rpt", "");
const half = (probe.endDatetime - probe.startDatetime) / 2000;
probe.destroy();

const whole = session("whole");
const first = session("first", { saveAt: half });
const rest = session("rest", { restore: first.checkpoint });
if (!(first.at > 0)) throw new Error("The checkpoint was not taken");
if (rest.out.length !== whole.out.length || rest.out.some((b, i) => b !== whole.out[i]))
  throw new Error(
    `A run resumed at ${first.at} s wrote a different .out (${rest.out.length} bytes, ` +
      `uninterrupted ${whole.out.length})`,
  );
console.log(`checkpoint smoke: saved at ${first.at} s, resumed .out identical (${rest.out.length} bytes)`);
