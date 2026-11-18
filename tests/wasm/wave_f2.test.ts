/**
 * Real module, wave F part 2: native water peers (`solver.split`), with both
 * peers in one module instance, following
 * python/tests/engine/test_native_split.py on its deck.
 *
 * Results go to tests/_work/wasm/f2/wave_f2.json for
 * tests/_work/wasm/f2/crosscheck.py (run by hand with native Python).
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { built, load, title, work } from "./load.js";
import { SPLIT_DECK } from "./decks.js";

type Pkg = Awaited<ReturnType<typeof load>>["pkg"];
type Solver = InstanceType<Pkg["Solver"]>;
type SplitFrame = InstanceType<Pkg["SplitFrame"]>;

/** The `peers` fixture: configured network and surface with applied geometry. */
async function peers() {
  const { mod, pkg } = await load();
  const solvers: Solver[] = [];
  const opened = (out: boolean) => {
    const s = new pkg.Solver(mod);
    s.writeFile("/split.inp", SPLIT_DECK);
    const name = `/peer-${solvers.length}`;
    s.open("/split.inp", `${name}.rpt`, out ? `${name}.out` : "");
    solvers.push(s);
    return s;
  };
  const network = opened(true);
  const surface = opened(false);
  network.split.validateInput();
  network.split.configure(pkg.SplitRole.NETWORK);
  surface.split.configure(pkg.SplitRole.SURFACE);
  surface.initialize();
  const frame = surface.split.geometry();
  network.initialize();
  network.split.applyGeometry(frame);
  const release = () => {
    for (const s of solvers.reverse()) s.destroy();
  };
  return { pkg, network, surface, frame, opened, release };
}

class LookupError extends Error {}

describe.skipIf(!built)(title("real module: wave F part 2 (native split peers)"), () => {
  const evidence: Record<string, unknown> = {};
  afterAll(() => {
    const out = resolve(work, "f2");
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "wave_f2.json"), JSON.stringify(evidence, null, 1) + "\n");
  });

  it("owns geometry frames, closes them once and checks inputs natively", async () => {
    const { pkg, network, surface, frame, release } = await peers();
    try {
      expect(frame.phase).toBe(0);
      expect(frame.time[2]).toBe(0);
      expect(frame.node(0).depthM).toBeGreaterThanOrEqual(0);
      evidence.geometry = { phase: frame.phase, time: frame.time, node: frame.node(0) };
      expect(() => frame.node(-1)).toThrow(pkg.EngineError);
      expect(() => frame.source(0)).toThrow(pkg.EngineError);
      expect(() => frame.outfallReturn(0)).toThrow(pkg.EngineError);
      frame.close();
      frame.close();
      expect(() => network.split.applyGeometry(frame)).toThrow(RangeError);
      let second: SplitFrame;
      {
        using scoped = surface.split.geometry();
        second = scoped;
        expect(scoped.node(0).headM).toBeGreaterThanOrEqual(0);
      }
      expect(() => second.time).toThrow(RangeError);
    } finally {
      release();
    }
  });

  it("expires callback requests, transfers replies and runs to the end", async () => {
    const { pkg, network, surface, frame, release } = await peers();
    try {
      const requests: SplitFrame[] = [];
      const replies: SplitFrame[] = [];
      const phases: number[] = [];
      const exchange = (phase: number, request: SplitFrame) => {
        phases.push(phase);
        requests.push(request);
        expect(request.time[2] > 0 || phase === pkg.SplitPhase.FINISH).toBe(true);
        expect(() => request.close()).toThrow(RangeError);
        const reply = surface.split.evaluate(phase, request);
        replies.push(reply);
        return reply;
      };
      network.split.setCallback(exchange);
      network.split.setCallback(null);
      network.split.setCallback(exchange);
      surface.start(false);
      network.start(false);
      const elapsed: number[] = [];
      for (let i = 0; i < 100; i++) {
        const t = network.step();
        if (!t) break;
        elapsed.push(t);
      }
      expect(elapsed.length).toBeLessThan(100);
      expect(phases).toContain(pkg.SplitPhase.ADVANCE);
      const surfaceVolume = surface.surface2d.totalVolume; // the surface finishes in end()
      network.end();
      expect(phases).toContain(pkg.SplitPhase.FINISH);
      for (const value of [...requests, ...replies]) expect(() => value.time).toThrow(RangeError);
      evidence.run = {
        phases,
        elapsed,
        networkDepth: network.nodes.get(0).depth,
        surfaceVolume,
      };
      frame.close();
    } finally {
      release();
    }
  });

  for (const failure of ["exception", "alias", "wrong_type"] as const) {
    it(`stops on a failed callback (${failure}) and keeps the native lifecycle`, async () => {
      const { pkg, network, surface, frame, release } = await peers();
      try {
        network.split.setCallback((_phase, request) => {
          if (failure === "exception") throw new LookupError("deliberate split callback failure");
          return (failure === "alias" ? request : null) as unknown as SplitFrame;
        });
        surface.start(false);
        network.start(false);
        const expected = { exception: LookupError, alias: RangeError, wrong_type: TypeError }[
          failure
        ];
        expect(() => network.step()).toThrow(expected);
        expect(() => network.split.setCallback(null)).toThrow(pkg.LifecycleError);
        frame.close();
      } finally {
        release();
      }
    });
  }

  it("round-trips UTF-8 phase packets through a third peer", async () => {
    const { pkg, surface, frame, opened, release } = await peers();
    try {
      let text: string;
      try {
        text = surface.split.encode(frame);
      } catch (err) {
        expect(err).toBeInstanceOf(pkg.PluginError);
        expect(() => surface.split.decode("{}")).toThrow(pkg.PluginError);
        evidence.packets = "codec not built";
        return;
      }
      const receiver = opened(true);
      receiver.split.configure(pkg.SplitRole.NETWORK);
      receiver.initialize();
      {
        using decoded = receiver.split.decode(text);
        expect(decoded.phase).toBe(frame.phase);
        expect(decoded.time).toEqual(frame.time);
        expect(() => decoded.node(0)).toThrow(pkg.EngineError);
        receiver.split.applyGeometry(decoded);
      }
      expect(() => surface.split.decode('{"broken": "雨"}')).toThrow(pkg.EngineError);
      expect(() => surface.split.decode(text + "\0")).toThrow(RangeError);
      evidence.packets = JSON.parse(text);
      frame.close();
    } finally {
      release();
    }
  });

  it("expires participant views on close and refuses non-solver owners", async () => {
    const { pkg, surface, frame, release } = await peers();
    try {
      const view = surface.split;
      surface.close();
      expect(() => view.geometry()).toThrow(pkg.StaleObjectError);
      frame.close();
      const empty = new pkg.SplitFrame();
      empty.close();
      expect(() => empty.phase).toThrow(RangeError);
      expect(() => new pkg.SplitFrame({} as Solver)).toThrow(TypeError);
      expect(() => new pkg.SplitParticipant({} as Solver)).toThrow(TypeError);
      for (const invoke of [
        () => surface.split.applyGeometry(null as unknown as SplitFrame),
        () => surface.split.evaluate(pkg.SplitPhase.ADVANCE, null as unknown as SplitFrame),
        () => surface.split.encode(null as unknown as SplitFrame),
      ]) {
        expect(invoke).toThrow(TypeError);
      }
    } finally {
      release();
    }
  });
});
