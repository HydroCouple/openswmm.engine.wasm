/**
 * Real module, wave F part 4: flow tracing (`FlowTracer`), following
 * python/tests/engine/test_trace.py, including its hand-written binary output
 * (`writeOutput` is a byte-for-byte port of the test's `write_output`).
 *
 * Results go to tests/_work/wasm/f4/wave_f4.json for
 * tests/_work/wasm/f4/crosscheck.py (run by hand with native Python).
 */
import { describe, it, expect, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { built, load, title, work } from "./load.js";

type Loaded = Awaited<ReturnType<typeof load>>;

/** Small public-format output with reversed ID order and unequal periods. */
function writeOutput(units = 3): Uint8Array {
  const bytes: number[] = [];
  const view = new DataView(new ArrayBuffer(8));
  const put = (n: number) => bytes.push(...new Uint8Array(view.buffer, 0, n));
  const integer = (v: number) => (view.setInt32(0, v, true), put(4));
  const real = (v: number) => (view.setFloat32(0, v, true), put(4));
  const date = (v: number) => (view.setFloat64(0, v, true), put(8));
  for (const v of [516114522, 60000, units, 0, 2, 1, 0]) integer(v);
  const ids = bytes.length;
  for (const v of ["O", "S", "SO"]) {
    integer(v.length);
    bytes.push(...new TextEncoder().encode(v));
  }
  const inputs = bytes.length;
  for (const v of [1, 1, 3, 0, 1, 2]) integer(v);
  for (let node = 0; node < 2; node++) {
    integer(node === 0 ? 1 : 0);
    real(0);
    real(10);
  }
  integer(5);
  for (let v = 0; v < 5; v++) integer(v);
  integer(0);
  for (let i = 0; i < 4; i++) real(1);
  for (const count of [0, 6, 5, 0]) {
    integer(count);
    for (let v = 0; v < count; v++) integer(v);
  }
  date(45000);
  integer(3600);
  const output = bytes.length;
  for (const [hour, flow, volume] of [
    [1, -2, 10],
    [2, 2, 20],
    [4, 6, 40],
  ]) {
    date(45000 + hour / 24);
    for (let node = 0; node < 2; node++) {
      for (const v of [0, 0, node ? volume : 0, node ? flow : 0, Math.abs(flow), 0]) real(v);
    }
    for (const v of [flow, 0, flow, volume, 0]) real(v);
  }
  for (const v of [ids, inputs, output, 3, 0, 516114522]) integer(v);
  return Uint8Array.from(bytes);
}

describe.skipIf(!built)(title("real module: wave F part 4 (flow tracing)"), () => {
  const evidence: Record<string, unknown> = {};
  afterAll(() => {
    const out = resolve(work, "f4");
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "wave_f4.json"), JSON.stringify(evidence, null, 1) + "\n");
  });

  const twoNodes = ({ mod, pkg }: Loaded) =>
    new pkg.FlowTracer(
      mod,
      [{ id: "S" }, { id: "O", type: pkg.NodeType.OUTFALL }],
      [{ id: "SO", fromNode: 0, toNode: 1, lengthM: 30 }],
    );
  const setUnitFlow = (trace: ReturnType<typeof twoNodes>) =>
    trace.setAverages(
      [{ lateralInM3s: 1 }, {}],
      [{ netFlowM3s: 1, absoluteFlowM3s: 1, absoluteVelocityMps: 1 }],
    );

  it("splits, joins and traces upstream", async () => {
    const { mod, pkg } = await load();
    const { NodeType, TraceTerminal, TraceDirection } = pkg;
    const nodes: { id: string; type?: (typeof NodeType)[keyof typeof NodeType] }[] = [
      { id: "S" },
      { id: "A" },
      { id: "B" },
      { id: "O", type: NodeType.OUTFALL },
    ];
    const links = [
      { id: "SA", fromNode: 0, toNode: 1, lengthM: 10 },
      { id: "SB", fromNode: 0, toNode: 2, lengthM: 20 },
      { id: "AO", fromNode: 1, toNode: 3, lengthM: 10 },
      { id: "BO", fromNode: 2, toNode: 3, lengthM: 20 },
    ];
    let result;
    {
      using trace = new pkg.FlowTracer(mod, nodes, links, {
        options: pkg.FlowTracer.defaultOptions(mod),
      });
      expect(trace.nodeIds).toEqual(["S", "A", "B", "O"]);
      expect(trace.linkIds).toEqual(["SA", "SB", "AO", "BO"]);
      const [topoNodes, topoLinks] = trace.topology;
      expect(topoNodes.map((n) => [n.id, n.type, n.flags])).toEqual([
        ["S", NodeType.JUNCTION, 0],
        ["A", NodeType.JUNCTION, 0],
        ["B", NodeType.JUNCTION, 0],
        ["O", NodeType.OUTFALL, 0],
      ]);
      expect(topoLinks.map((l) => [l.id, l.fromNode, l.toNode, l.type, l.lengthM])).toEqual(
        links.map((l) => [l.id, l.fromNode, l.toNode, pkg.LinkType.CONDUIT, l.lengthM]),
      );
      nodes.length = 0; // the native handle owns its topology
      trace.setAverages(
        [{ lateralInM3s: 10 }, {}, {}, {}],
        [6, 4, 6, 4].map((q) => ({ netFlowM3s: q, absoluteFlowM3s: q, absoluteVelocityMps: 1 })),
        { info: { durationS: 120 } },
      );
      expect(trace.info.nodeCount).toBe(4);
      expect(trace.info.durationS).toBe(120);
      result = trace.estimate("S");
      expect(result.links[0].ratio).toBeCloseTo(0.6, 12);
      expect(result.links[1].ratio).toBeCloseTo(0.4, 12);
      expect(result.links[0].terminalKind).toBeNull();
      expect(result.nodes[3].timeS).toBeCloseTo(28, 10);
      expect(result.summary.terminal[TraceTerminal.OUTFALL]).toBeCloseTo(1, 12);
      const upstream = trace.estimate(3, TraceDirection.UPSTREAM);
      expect(upstream.nodes[0].timeS).toBeCloseTo(28, 10);
      expect(upstream.summary.terminal[TraceTerminal.SOURCE]).toBeCloseTo(1, 12);
      expect(trace.averages[1][0].travelS).toBe(10);
      evidence.confluence = {
        downstream: result,
        upstream,
        averages: trace.averages,
        info: trace.info,
      };
    }
    expect(result.nodes[3].ratio).toBeCloseTo(1, 12); // snapshots survive close
  });

  it("keeps unknown times, empty links and cycle ratios", async () => {
    const loaded = await load();
    const { mod, pkg } = loaded;
    {
      using trace = twoNodes(loaded);
      trace.setAverages([{}, {}], [{ netFlowM3s: 1, absoluteFlowM3s: 1 }]);
      const result = trace.estimate("S");
      expect(Number.isNaN(result.links[0].timeS)).toBe(true);
      expect(result.links[0].flags & pkg.TraceFlags.UNKNOWN_TIME).toBeTruthy();
      evidence.unknownTimes = result;
    }
    {
      using trace = new pkg.FlowTracer(mod, [{ id: "dry" }], []);
      trace.setAverages([{}], []);
      expect(trace.linkIds).toEqual([]);
      expect(trace.averages[1]).toEqual([]);
      expect(trace.topology[1]).toEqual([]);
      expect(trace.estimate("dry").summary.terminal[pkg.TraceTerminal.RETAINED]).toBe(1);
    }
    {
      using trace = new pkg.FlowTracer(
        mod,
        [{ id: "S" }, { id: "A" }, { id: "O", type: pkg.NodeType.OUTFALL }],
        [
          { id: "SA", fromNode: 0, toNode: 1, lengthM: 4 },
          { id: "AS", fromNode: 1, toNode: 0, lengthM: 6 },
          { id: "AO", fromNode: 1, toNode: 2, lengthM: 2 },
        ],
      );
      trace.setAverages(
        [{ lateralInM3s: 1 }, {}, {}],
        [2, 1, 1].map((q) => ({ netFlowM3s: q, absoluteFlowM3s: q, absoluteVelocityMps: 1 })),
      );
      const result = trace.estimate("S");
      expect(result.summary.cyclic).toBeTruthy();
      expect(result.links[0].ratio).toBeCloseTo(2, 12);
      expect(result.nodes[2].timeS).toBeCloseTo(16, 10);
      evidence.cycle = result;
    }
  });

  it("validates inputs and handle lifetime", async () => {
    const loaded = await load();
    const { mod, pkg } = loaded;
    const defaults = pkg.FlowTracer.defaultOptions(mod);
    expect(defaults).toEqual({
      flowEpsilonM3s: 1e-9,
      velocityEpsilonMps: 1e-6,
      reversalDominance: 0.8,
      solverTolerance: 1e-11,
      maxIterations: 10000,
    });
    const invalid: [object[], object[], object | null][] = [
      [[], [], null],
      [[{ id: "S" }, { id: "S" }], [], null],
      [[{ id: "S" }], [{ id: "L", fromNode: 0, toNode: 5 }], null],
      [[{ id: "S" }], [], { maxIterations: 0 }],
    ];
    for (const [nodes, links, options] of invalid) {
      let error: unknown;
      try {
        new pkg.FlowTracer(mod, nodes, links, { options });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(pkg.TraceError);
      expect((error as InstanceType<typeof pkg.TraceError>).code).toBe(pkg.TraceStatus.INVALID);
    }
    expect(() => new pkg.FlowTracer(mod, [{ id: "bad\0id" }], [])).toThrow(/NUL/);
    const trace = twoNodes(loaded);
    expect(() => trace.averages).toThrow(pkg.TraceError);
    expect(() => trace.setAverages([], [])).toThrow(/row counts/);
    setUnitFlow(trace);
    expect(() => trace.estimate(8)).toThrow(RangeError);
    expect(() => trace.estimate(-1)).toThrow(RangeError);
    expect(() => trace.estimate("absent")).toThrow(pkg.ElementNotFoundError);
    expect(() => trace.estimate(0.5)).toThrow(TypeError);
    expect(() => trace.estimate(0, 5 as never)).toThrow(RangeError);
    expect(() => trace.estimate(0, undefined, { progress: 42 as never })).toThrow(TypeError);
    trace.close();
    trace.close();
    expect(() => trace.info).toThrow(/closed/);
  });

  it("cancels, propagates callback errors and refuses reentry", async () => {
    const loaded = await load();
    const { pkg } = loaded;
    using trace = twoNodes(loaded);
    setUnitFlow(trace);
    let error: unknown;
    try {
      trace.estimate("S", undefined, { progress: () => true });
    } catch (err) {
      error = err;
    }
    expect((error as InstanceType<typeof pkg.TraceError>).code).toBe(pkg.TraceStatus.CANCELLED);
    expect(() =>
      trace.estimate("S", undefined, {
        progress: () => {
          throw new SyntaxError("callback failed");
        },
      }),
    ).toThrow(/callback failed/);
    expect(() => trace.estimate("S", undefined, { progress: () => trace.close() })).toThrow(
      /in use/,
    );
    expect(trace.estimate("S").nodes[1].ratio).toBeCloseTo(1, 12);
  });

  it("prepares averages from a binary output, by ID, with cancellation and errors", async () => {
    const loaded = await load();
    const { mod, pkg } = loaded;
    const { TraceStatus } = pkg;
    mod.FS.writeFile("/hydraulics.out", writeOutput());
    const status = (fn: () => void) => {
      try {
        fn();
      } catch (err) {
        return (err as InstanceType<typeof pkg.TraceError>).code;
      }
      return TraceStatus.OK;
    };
    {
      using trace = twoNodes(loaded);
      const seen: [number, string][] = [];
      trace.prepare("/hydraulics.out", { progress: (f, s) => void seen.push([f, s]) });
      expect(seen.length).toBeGreaterThan(0);
      expect(trace.info.periods).toBe(3);
      expect(trace.info.durationS).toBeCloseTo(10800, 9);
      const [nodes, links] = trace.averages;
      expect(nodes[0].volumeM3).toBeCloseTo(25, 4); // pytest.approx: relative 1e-6
      expect(links[0].netFlowM3s).toBeCloseTo(8 / 3, 5);
      expect(links[0].travelS).toBeCloseTo(10, 5);
      const result = trace.estimate("S");
      expect(result.nodes[1].ratio).toBeCloseTo(16 / 17, 6);
      expect(result.summary.terminal[pkg.TraceTerminal.LOSS]).toBeCloseTo(1 / 17, 7);
      evidence.prepared = { seen, info: trace.info, averages: trace.averages, result };
      expect(status(() => trace.prepare("/hydraulics.out", { progress: () => true }))).toBe(
        TraceStatus.CANCELLED,
      );
      expect(status(() => trace.prepare("/absent.out"))).toBe(TraceStatus.IO);
      expect(() => trace.prepare("/hydraulics.out", { cachePath: "/cache.h5" })).toThrow(
        /fingerprint/,
      );
    }
    {
      using trace = new pkg.FlowTracer(
        mod,
        [{ id: "missing" }, { id: "O", type: pkg.NodeType.OUTFALL }],
        [{ id: "SO", fromNode: 0, toNode: 1, lengthM: 30 }],
      );
      expect(status(() => trace.prepare("/hydraulics.out"))).toBe(TraceStatus.MISMATCH);
    }
  });

  it("prepares complete periods of a growing output and refreshes", async () => {
    const loaded = await load();
    const { mod, pkg } = loaded;
    const content = writeOutput().slice(0, -24); // no closing footer
    const periodSize = 8 + 4 * (2 * 6 + 5);
    const last = content.slice(-periodSize);
    const head = content.slice(0, -periodSize);
    mod.FS.writeFile("/growing.out", Uint8Array.from([...head, ...last.slice(0, 9)]));
    using trace = twoNodes(loaded);
    const seen: number[] = [];
    trace.prepareLive("/growing.out", { progress: (f) => void seen.push(f) });
    expect(seen.length).toBeGreaterThan(0);
    expect(trace.info.periods).toBe(2);
    expect(trace.info.cacheLoaded).toBe(0);
    const partial = trace.averages;
    mod.FS.writeFile("/growing.out", Uint8Array.from([...head, ...last]));
    trace.prepareLive("/growing.out");
    expect(trace.info.periods).toBe(3);
    expect(trace.info.durationS).toBeCloseTo(10800, 9);
    expect(trace.averages[1][0].netFlowM3s).toBeCloseTo(8 / 3, 5);
    const complete = trace.averages;
    expect(() => trace.prepare("/growing.out")).toThrow(pkg.TraceError);
    let code: unknown;
    try {
      trace.prepareLive("/missing.out");
    } catch (err) {
      code = (err as InstanceType<typeof pkg.TraceError>).code;
    }
    expect(code).toBe(pkg.TraceStatus.IO);
    evidence.live = { partial, complete };
  });

  it("caches prepared averages and restores them in a new handle", async () => {
    const loaded = await load();
    const { mod, pkg } = loaded;
    const bytes = writeOutput();
    mod.FS.writeFile("/hydraulics.out", bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    let nodes, links, info, expected;
    {
      using trace = twoNodes(loaded);
      try {
        trace.prepare("/hydraulics.out", { cachePath: "/trace.h5", fingerprint: digest });
      } catch (err) {
        if ((err as InstanceType<typeof pkg.TraceError>).code !== pkg.TraceStatus.NO_HDF5)
          throw err;
        evidence.cache = "engine built without HDF5 caching";
        return;
      }
      expect(trace.info.cacheLoaded).toBe(0);
      trace.prepare("/hydraulics.out", { cachePath: "/trace.h5", fingerprint: digest });
      expect(trace.info.cacheLoaded).toBe(1);
      [nodes, links] = trace.averages;
      info = trace.info;
      expected = trace.estimate("S");
    }
    using restored = twoNodes(loaded);
    restored.setAverages(nodes, links, { info });
    expect(restored.estimate("S").nodes[1].timeS).toBeCloseTo(expected.nodes[1].timeS, 12);
    mod.FS.writeFile("/us.out", writeOutput(0));
    restored.prepare("/us.out");
    expect(restored.averages[1][0].absoluteFlowM3s).toBeCloseTo(3 * 0.028316846592, 7);
    evidence.cache = {
      info,
      restored: restored.averages,
      cachedBytes: mod.FS.stat("/trace.h5").size > 0,
    };
  });
});
