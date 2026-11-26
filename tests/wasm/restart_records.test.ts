/**
 * Real module: `solver.restart` ([RESTART]) records restart states into an HDF5
 * file and starts a run from one; `probeRestartFile` / `inspectRestartFile`
 * read the file; `backendInfo` and `fvDeviceSupported` answer without a GPU.
 * Mirrors the engine's python/tests/engine/test_restart_records.py.
 */
import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { built, load, title, work } from "./load.js";

// Three-node dynamic-wave network with a time-varying inflow.
const deck = (start = "00:00:00", end = "01:00:00") => `[OPTIONS]
FLOW_UNITS CFS
FLOW_ROUTING DYNWAVE
START_DATE 01/01/2020
START_TIME ${start}
REPORT_START_DATE 01/01/2020
REPORT_START_TIME 00:00:00
END_DATE 01/01/2020
END_TIME ${end}
REPORT_STEP 00:01:00
ROUTING_STEP 15

[JUNCTIONS]
J1 10 6 0 0 0
J2 8 6 0 0 0

[OUTFALLS]
O1 5 FREE

[CONDUITS]
C1 J1 J2 400 0.013 0 0 0 0
C2 J2 O1 400 0.013 0 0 0 0

[XSECTIONS]
C1 CIRCULAR 1.5 0 0 0 1
C2 CIRCULAR 1.5 0 0 0 1

[TIMESERIES]
TS1 0:00 0
TS1 0:20 3
TS1 0:40 1
TS1 1:00 0

[INFLOWS]
J1 FLOW TS1
`;

describe.skipIf(!built)(title("real module: restart records"), () => {
  it("records into HDF5, inspects the file and starts a run from a record", async () => {
    const { mod, pkg } = await load();
    const run = (
      name: string,
      text: string,
      setup?: (s: InstanceType<typeof pkg.Solver>) => void,
    ) => {
      const solver = new pkg.Solver(mod);
      try {
        solver.writeFile(`/${name}.inp`, text);
        solver.open(`/${name}.inp`, `/${name}.rpt`, `/${name}.out`);
        setup?.(solver);
        solver.initialize();
        solver.start(true);
        while (solver.step()) {
          /* run to the end */
        }
        const depths = Array.from(
          { length: solver.nodes.length },
          (_, i) => solver.nodes.get(i).depth,
        );
        solver.end();
        solver.report();
        return depths;
      } finally {
        solver.close();
        solver.destroy();
      }
    };

    // Record at 00:30 and at the end.
    run("a", deck(), (s) => {
      const r = s.restart;
      expect(r).toBeInstanceOf(pkg.RestartSettings);
      r.recordFile = "/states.h5";
      r.recordFormat = "HDF5";
      r.recordAt = ["END", new Date(Date.UTC(2020, 0, 1, 0, 30))];
      r.recordEvery = 0;
      expect(r.recordFile).toBe("/states.h5");
      expect(r.recordFormat).toBe("HDF5");
      expect(r.recordEvery).toBe(0);
      expect(r.recordContinuation).toBe(false);
      const at = r.recordAt;
      expect(at).toHaveLength(2);
      expect(at[0]).toBe("END");
      expect((at[1] as Date).toISOString()).toBe("2020-01-01T00:30:00.000Z");
    });

    expect(pkg.probeRestartFile(mod, "/states.h5")).toBe("HDF5");
    expect(pkg.probeRestartFile(mod, "/a.inp")).toBe("OTHER");
    expect(pkg.probeRestartFile(mod, "/nowhere.gpkg")).toBe("NONE");
    const catalog = pkg.inspectRestartFile(mod, "/states.h5") as {
      backend: string;
      runs: { run_id: string; records: { record_id: string; status: string }[] }[];
    };
    writeFileSync(resolve(work, "restart_records_catalog.json"), JSON.stringify(catalog, null, 2));
    expect(catalog.backend).toBe("HDF5");
    expect(catalog.runs).toHaveLength(1);
    const runId = catalog.runs[0].run_id;
    expect(runId.startsWith("run_")).toBe(true);
    expect(catalog.runs[0].records.map((r) => r.record_id)).toEqual(["rec_000001", "rec_000002"]);
    expect(catalog.runs[0].records.every((r) => r.status === "complete")).toBe(true);
    expect(() => pkg.inspectRestartFile(mod, "/nowhere.gpkg")).toThrow();

    // A two-minute target started from the 00:30 record differs from a cold start.
    const target = deck("00:30:00", "00:32:00");
    const cold = run("b", target);
    const warm = run("c", target, (s) => {
      s.restart.sourceFile = "/states.h5";
      s.restart.sourceRun = runId;
      s.restart.sourceRecord = "rec_000001";
      s.restart.mode = "INITIAL_CONDITIONS";
      expect(s.restart.mode).toBe("INITIAL_CONDITIONS");
    });
    writeFileSync(
      resolve(work, "restart_records_depths.json"),
      JSON.stringify({ cold, warm }, null, 2),
    );
    expect(warm).not.toEqual(cold);
  });

  it("answers backend and device-scope questions without a GPU", async () => {
    const { mod, pkg } = await load();
    const cpu = pkg.backendInfo(mod, pkg.BackendSolver.SURFACE_2D, "CPU");
    expect(cpu.usable).toBe(true);
    expect(cpu.reason).toBe("");
    const cuda = pkg.backendInfo(mod, pkg.BackendSolver.FV_NETWORK, "CUDA");
    expect(cuda.usable).toBe(false);
    expect(cuda.reason.length).toBeGreaterThan(0);
    expect(cuda.deviceMemBytes).toBe(0);
    writeFileSync(
      resolve(work, "restart_records_backend_info.json"),
      JSON.stringify({ cpu, cuda }, null, 2),
    );

    const solver = new pkg.Solver(mod);
    try {
      solver.writeFile("/fv.inp", deck());
      solver.open("/fv.inp", "/fv.rpt", "/fv.out");
      const [supported, why] = solver.fvDeviceSupported();
      expect(typeof supported).toBe("boolean");
      expect(typeof why).toBe("string");
      expect(supported).toBe(why === "");
    } finally {
      solver.close();
      solver.destroy();
    }
  });
});
