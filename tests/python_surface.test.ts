/**
 * Python public-surface parity gate.
 *
 * tests/fixtures/python_surface.json (tools/gen_python_surface.py) lists every
 * public class, member and module function of the pinned engine's Python
 * bindings. Each module that is not pending or excluded in
 * tools/python_surface_map.json must have a TypeScript counterpart for every
 * entry: snake_case members as camelCase (case-insensitive, so `2d`/`2D` and
 * `crs`/`CRS` both match), protocol dunders through the map. The TypeScript
 * surface is read from src/js with the TypeScript compiler API. The coverage of
 * every module, pending ones included, is written to
 * tests/_work/python_parity_report.json.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import surfaceJson from "./fixtures/python_surface.json" with { type: "json" };
import mapJson from "../tools/python_surface_map.json" with { type: "json" };

interface PyClass {
  bases: string[];
  members: Record<string, string>;
}
interface PyModule {
  functions: string[];
  classes: Record<string, PyClass>;
}
interface SurfaceMap {
  dunders: Record<string, string[]>;
  classAliases: Record<string, string>;
  memberAliases: Record<string, string>;
  excluded: Record<string, string>;
  pending: Record<string, string>;
}
interface TsType {
  kind: "class" | "interface" | "enum";
  members: Set<string>;
  heritage: string[];
}

const surface = surfaceJson as Record<string, PyModule>;
const map = mapJson as unknown as SurfaceMap;
const ENUM_BASES = new Set(["IntEnum", "IntFlag", "Enum", "Flag"]);

function isHidden(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some(
    (m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword,
  );
}

function memberName(name: ts.PropertyName | undefined): string | undefined {
  if (!name || ts.isPrivateIdentifier(name)) return undefined;
  if (ts.isComputedPropertyName(name)) return `[${name.expression.getText()}]`;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function isExported(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** Classes, interfaces, enums and exported functions declared under src/js. */
function readTypeScriptSurface(dir: string) {
  const types = new Map<string, TsType>();
  const functions = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const text = readFileSync(resolve(dir, file), "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const stmt of source.statements) {
      if ((ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) && stmt.name) {
        const members = new Set<string>();
        for (const m of stmt.members) {
          if (isHidden(m)) continue;
          if (ts.isConstructorDeclaration(m)) {
            for (const p of m.parameters) {
              if (ts.isParameterPropertyDeclaration(p, m) && !isHidden(p)) {
                members.add(p.name.getText());
              }
            }
            continue;
          }
          const name = memberName(m.name);
          if (name) members.add(name);
        }
        const heritage = (stmt.heritageClauses ?? [])
          .filter((h) => h.token === ts.SyntaxKind.ExtendsKeyword)
          .flatMap((h) => h.types.map((t) => t.expression.getText()));
        const kind = ts.isClassDeclaration(stmt) ? "class" : "interface";
        types.set(stmt.name.text, { kind, members, heritage });
      } else if (ts.isEnumDeclaration(stmt)) {
        const members = new Set(stmt.members.map((m) => m.name.getText()));
        types.set(stmt.name.text, { kind: "enum", members, heritage: [] });
      } else if (ts.isFunctionDeclaration(stmt) && stmt.name && isExported(stmt)) {
        functions.add(stmt.name.text);
      } else if (ts.isVariableStatement(stmt) && isExported(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          const init = decl.initializer;
          if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
            functions.add(decl.name.getText());
          }
        }
      }
    }
  }
  return { types, functions };
}

const tsSurface = readTypeScriptSurface(resolve(__dirname, "..", "src", "js"));

/** Members a class inherits from JavaScript built-ins it extends. */
const BUILTIN_MEMBERS: Record<string, string[]> = { Error: ["message", "name", "stack", "cause"] };

function allMembers(name: string, seen = new Set<string>()): Set<string> {
  if (name in BUILTIN_MEMBERS) return new Set(BUILTIN_MEMBERS[name]);
  const type = tsSurface.types.get(name);
  if (!type || seen.has(name)) return new Set();
  seen.add(name);
  const out = new Set(type.members);
  for (const base of type.heritage) for (const m of allMembers(base, seen)) out.add(m);
  return out;
}

const camel = (s: string) => s.replace(/_([a-z0-9])/gi, (_, c: string) => c.toUpperCase());
const hasName = (names: Iterable<string>, wanted: string) => {
  const w = wanted.toLowerCase();
  for (const n of names) if (n.toLowerCase() === w) return true;
  return false;
};

/**
 * Python entries of one module with no TypeScript counterpart. Entries whose
 * `module.Class.member`, `module.Class` or `module.function` key is pending go
 * to `pending` (with their wave) instead of `missing`.
 */
function missingIn(module: string): { total: number; missing: string[]; pending: string[] } {
  const py = surface[module];
  const missing: string[] = [];
  const pending: string[] = [];
  let total = 0;
  const miss = (label: string, ...keys: string[]) => {
    const wave = keys.map((k) => map.pending[k]).find(Boolean);
    if (wave) pending.push(`${label} (wave ${wave})`);
    else missing.push(label);
  };
  for (const fn of py.functions) {
    if (`${module}.${fn}` in map.excluded) continue;
    total++;
    if (!hasName(tsSurface.functions, camel(fn))) miss(`${fn}()`, `${module}.${fn}`);
  }
  for (const [cls, spec] of Object.entries(py.classes)) {
    if (`${module}.${cls}` in map.excluded) continue;
    const tsName = map.classAliases[cls] ?? cls;
    const type = tsSurface.types.get(tsName);
    total++;
    if (spec.bases.some((b) => ENUM_BASES.has(b))) {
      if (type?.kind !== "enum") miss(`${cls} (enum)`, `${module}.${cls}`);
      continue;
    }
    const members = type ? allMembers(tsName) : new Set<string>();
    if (!type) miss(cls, `${module}.${cls}`);
    for (const member of Object.keys(spec.members)) {
      const key = `${module}.${cls}.${member}`;
      if (key in map.excluded) continue;
      total++;
      // camelCase, or the Python name itself (constants such as WATER_AGE keep theirs).
      const candidates = map.dunders[member] ?? [
        map.memberAliases[`${cls}.${member}`] ?? camel(member),
        member,
      ];
      if (!candidates.some((c) => hasName(members, c))) {
        miss(`${cls}.${member}`, key, `${module}.${cls}`);
      }
    }
  }
  return { total, missing, pending };
}

const modules = Object.keys(surface).sort();
const isExcludedModule = (m: string) => m in map.excluded;

/** True when a `module`, `module.Class`, `module.function` or `module.Class.member` key exists. */
function resolves(key: string): boolean {
  const [m, cls, member] = key.split(".");
  const py = surface[m];
  if (!py) return false;
  if (cls === undefined) return true;
  if (member === undefined) return cls in py.classes || py.functions.includes(cls);
  return member in (py.classes[cls]?.members ?? {});
}

describe("Python public surface", () => {
  it("map entries refer to the current Python surface and TypeScript classes", () => {
    const stale: string[] = [];
    for (const key of Object.keys(map.pending)) if (!resolves(key)) stale.push(`pending ${key}`);
    for (const key of Object.keys(map.excluded)) if (!resolves(key)) stale.push(`excluded ${key}`);
    const pyClasses = new Set(modules.flatMap((m) => Object.keys(surface[m].classes)));
    for (const [py, tsName] of Object.entries(map.classAliases)) {
      if (!pyClasses.has(py) || !tsSurface.types.has(tsName)) stale.push(`classAlias ${py}`);
    }
    for (const key of Object.keys(map.memberAliases)) {
      const [cls, member] = key.split(".");
      const found = modules.some((m) => member in (surface[m].classes[cls]?.members ?? {}));
      if (!found) stale.push(`memberAlias ${key}`);
    }
    expect(stale).toEqual([]);
  });

  it("no key is both pending and excluded", () => {
    expect(Object.keys(map.pending).filter((k) => k in map.excluded)).toEqual([]);
  });

  for (const module of modules) {
    if (isExcludedModule(module)) continue;
    const wave = map.pending[module];
    if (wave) {
      it.skip(`${module}: pending facade wave ${wave}`, () => {});
      continue;
    }
    it(`${module}: every public Python entry has a TypeScript counterpart`, () => {
      expect(missingIn(module).missing).toEqual([]);
    });
  }

  it("writes the coverage report to tests/_work/python_parity_report.json", () => {
    const report: Record<string, unknown> = {};
    let total = 0;
    let present = 0;
    for (const module of modules) {
      if (isExcludedModule(module)) {
        report[module] = { excluded: map.excluded[module] };
        continue;
      }
      const r = missingIn(module);
      const absent = r.missing.length + r.pending.length;
      total += r.total;
      present += r.total - absent;
      report[module] = {
        status: map.pending[module] ? `pending wave ${map.pending[module]}` : "checked",
        present: r.total - absent,
        total: r.total,
        missing: r.missing,
        pending: r.pending,
      };
    }
    const work = resolve(__dirname, "_work");
    mkdirSync(work, { recursive: true });
    writeFileSync(
      resolve(work, "python_parity_report.json"),
      JSON.stringify({ present, total, modules: report }, null, 1) + "\n",
    );
    expect(present).toBeGreaterThan(0);
    expect(present).toBeLessThanOrEqual(total);
  });
});
