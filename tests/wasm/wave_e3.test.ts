/**
 * Real module, wave E part 3: the reaction system (species, coefficients,
 * terms, expressions, initial quality, options, validation and the .rxn text
 * round trip) on the deck of python/tests/engine/test_reactions.py.
 *
 * Results go to tests/_work/wasm/e3/wave_e3.json for
 * tests/_work/wasm/e3/crosscheck.py (run by hand with native Python).
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { built, load, title, work } from "./load.js";
import { REACTIONS_RXN, UNCOMPILABLE_RXN, reactionsInp } from "./decks.js";

describe.skipIf(!built)(title("real module: wave E part 3 (reactions)"), () => {
  const evidence: Record<string, unknown> = {};
  afterAll(() => {
    const out = resolve(work, "e3");
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "wave_e3.json"), JSON.stringify(evidence, null, 1) + "\n");
  });

  it("lists the expression vocabulary without a model", async () => {
    const { mod, pkg } = await load();
    const vars = pkg.Reactions.hydraulicVariables(mod);
    const fns = pkg.Reactions.functions(mod);
    expect(vars.map((v) => v.name)).toEqual(expect.arrayContaining(["D", "Q", "U", "HRT", "DT"]));
    expect(fns.find((f) => f.name === "POW")?.arity).toBe(2);
    expect(fns.find((f) => f.name === "EXP")?.arity).toBe(1);
    evidence.hydraulicVariables = vars;
    evidence.functions = fns;
  });

  it("edits, validates and round-trips the reaction system", async () => {
    const { mod, pkg } = await load();
    const { ReactionScope: S, ReactionExprForm: F } = pkg;
    const solver = new pkg.Solver(mod);
    try {
      solver.writeFile("/model.rxn", REACTIONS_RXN);
      solver.writeFile("/model.inp", reactionsInp("model.rxn"));
      solver.open("/model.inp", "/model.rpt", "/model.out");
      const rxn = solver.reactions;
      const sp = rxn.species;
      expect([...sp].map((s) => s.name)).toEqual(["X", "Y"]);
      expect(sp.get("Y").index).toBe(1);
      expect(sp.get(-1).name).toBe("Y");
      expect(sp.has("X") && !sp.has("Q") && !sp.has(5)).toBe(true);
      const x = sp.get("X");
      expect([x.isWall, x.units, x.atol, x.rtol]).toEqual([false, "MG", 0, 0]);
      expect(x.pipeExpression).toEqual([F.RATE, "-Kb * Kf * X"]);
      expect(x.tankExpression).toEqual([F.RATE, "-Kb * X"]);
      expect(x.getExpression(S.SUBCATCHMENT)).toEqual([F.NONE, ""]);
      expect(x.initial).toBe(8);
      x.rainConc = 0.25;
      expect(x.rainConc).toBe(0.25);
      const nh3 = sp.add("NH3", { units: "MG", atol: 1e-6, rtol: 1e-6 });
      nh3.setExpression(S.PIPE, F.RATE, "-Kb * NH3");
      nh3.initial = 0.5;
      expect(() => nh3.setExpression(S.PIPE, F.RATE, "-NOPE * NH3")).toThrow(pkg.BadParamError);
      expect(nh3.pipeExpression).toEqual([F.RATE, "-Kb * NH3"]);

      const kb = rxn.coefficients.get("Kb");
      expect([kb.isParam, kb.value]).toEqual([false, 0.05]);
      kb.value = 0.07;
      expect(rxn.coefficients.get(0).value).toBe(0.07);
      const kp = rxn.coefficients.add("Kp", { parameter: true, value: 1 });
      expect(kp.isParam).toBe(true);
      const kf = rxn.terms.get("Kf");
      expect(kf.expression).toBe("0.5 * DT");
      rxn.terms.add("K2", "Kf * 2");
      expect(() => rxn.terms.add("K3", "NOPE")).toThrow(pkg.BadParamError);
      expect(rxn.terms.length).toBe(2);

      expect(() => sp.remove("X")).toThrow(pkg.BadParamError);
      expect(() => rxn.coefficients.remove("Kb")).toThrow(pkg.BadParamError);
      expect(() => rxn.terms.remove("Kf")).toThrow(pkg.BadParamError);
      expect(() => sp.get("nope")).toThrow(pkg.ElementNotFoundError);
      expect(() => sp.get(9)).toThrow(RangeError);

      expect(rxn.validate("-Kb * X")).toEqual({ valid: true, message: "", column: -1 });
      const bad = rxn.validate("-Kb * NOPE", S.PIPE);
      evidence.badDiagnostic = bad;
      expect(bad.valid).toBe(false);

      evidence.rateUnits = rxn.getOption("RATE_UNITS");
      rxn.setOption("TIMESTEP", "60");
      evidence.timestep = rxn.getOption("TIMESTEP");

      const rows = rxn.initial;
      rows.set(false, 0, "X", 3.5);
      rows.set(true, 1, 1, 2);
      rows.set(false, 0, "X", 4); // updates the keyed row
      evidence.initialRows = [...rows];
      expect(rows.get(0)).toEqual({ isLink: false, elemIndex: 0, speciesIndex: 0, value: 4 });
      rows.remove(-1);
      expect(rows.length).toBe(1);

      const text = rxn.serialize();
      evidence.serialized = text;
      expect(rxn.checkText(text).valid).toBe(true);
      rxn.applyText(text);
      expect(rxn.serialize()).toBe(text);
      const refused = rxn.checkText(UNCOMPILABLE_RXN);
      evidence.uncompilable = refused;
      expect(refused.valid).toBe(false);
      expect(() => rxn.applyText(UNCOMPILABLE_RXN)).toThrow(pkg.EngineError);
      expect(rxn.serialize()).toBe(text);
      rxn.save("/saved.rxn");
      expect(solver.readFile("/saved.rxn", "utf8")).toBe(text);

      solver.initialize();
      solver.start(false);
      expect(() => rxn.species.add("LATE")).toThrow(pkg.LifecycleError);
      solver.until(600);
      solver.end();
    } finally {
      solver.destroy();
    }
  });
});
