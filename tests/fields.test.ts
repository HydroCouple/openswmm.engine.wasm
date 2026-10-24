/**
 * @file fields.test.ts
 * @brief Catalog-path field access (`solver.fields`).
 *
 * @details The generated table is checked against the raw manifest here; its
 * mapping onto C getters/setters is checked against the native engine and the
 * Python bindings by `tools/verify_fields_native.py`. The routing tests use a
 * small mock module.
 */

import { describe, expect, it } from "vitest";

import manifest from "../src/js/raw.manifest.json" with { type: "json" };
import coverage from "./fixtures/facade_coverage.json" with { type: "json" };
import {
  BadParamError,
  ElementNotFoundError,
  ELEMENTS,
  FIELDS,
  Fields,
  LifecycleError,
  Solver,
} from "../src/js/index.js";
import type { OpenSwmmWasmModule } from "../src/js/index.js";

const functions = manifest.functions as Record<string, { params: [string, string][] }>;

describe("generated field table", () => {
  it("names only functions the raw layer binds", () => {
    for (const [path, spec] of Object.entries(FIELDS)) {
      expect(functions[spec.get], `${path} getter`).toBeDefined();
      if (spec.set) expect(functions[spec.set], `${path} setter`).toBeDefined();
      if (spec.element) expect(ELEMENTS[spec.element], `${path} element`).toBeDefined();
    }
  });

  it("matches the coverage fixture", () => {
    expect(Object.keys(FIELDS).length).toBe(coverage.fields);
    expect(coverage.fields).toBeGreaterThan(150);
  });

  it("uses element getters for per-element fields only", () => {
    for (const spec of Object.values(FIELDS)) {
      const head = functions[spec.get].params.map((p) => p[0]).slice(0, 2);
      expect(head[1] === "int").toBe(Boolean(spec.element));
    }
  });
});

/** Mock engine: nodes J1 (index 0) and O1 (index 1); depth is runtime-only. */
function mockModule(): OpenSwmmWasmModule {
  const heap = new Map<number, number>();
  const bytes = new Uint8Array(1 << 16);
  let next = 1024;
  const ids = ["J1", "O1"];
  const maxDepth = [5, 0];
  const tags = ["", ""];
  const enc = new TextEncoder();
  const mod = {
    _malloc: (size: number) => {
      const p = next;
      next += size + 8;
      return p;
    },
    _free: () => {},
    getValue: (p: number) => heap.get(p) ?? 0,
    setValue: (p: number, v: number) => void heap.set(p, v),
    HEAPU8: bytes,
    UTF8ToString: (p: number, max?: number) => {
      let end = p;
      while (bytes[end] && (max === undefined || end - p < max)) end++;
      return new TextDecoder().decode(bytes.slice(p, end));
    },
    cwrap: (name: string) => (mod as Record<string, unknown>)[`_${name}`],
    _swmm_engine_create: () => 42,
    _swmm_node_count: () => ids.length,
    _swmm_node_index: (_h: number, id: string) => ids.indexOf(id),
    _swmm_node_get_max_depth: (_h: number, i: number, out: number) => {
      if (i < 0 || i >= ids.length) return 8;
      heap.set(out, maxDepth[i]);
      return 0;
    },
    _swmm_node_set_max_depth: (_h: number, i: number, v: number) => {
      maxDepth[i] = v;
      return 0;
    },
    _swmm_node_get_depth: () => 0,
    _swmm_node_set_depth: () => 6, // LIFECYCLE: runtime-only while OPENED
    _swmm_node_get_tag: (_h: number, i: number, buf: number, len: number) => {
      const b = enc.encode(tags[i]).slice(0, len - 1);
      bytes.set(b, buf);
      bytes[buf + b.length] = 0;
      return 0;
    },
    _swmm_node_set_tag: (_h: number, i: number, value: string) => {
      tags[i] = value;
      return 0;
    },
  };
  return mod as unknown as OpenSwmmWasmModule;
}

describe("Fields", () => {
  const solver = () => new Solver(mockModule());

  it("is attached to the solver and lists catalog paths", () => {
    const fields = solver().fields;
    expect(fields).toBeInstanceOf(Fields);
    expect(fields.paths()).toContain("node.max_depth");
    expect(fields.describe("node.max_depth").units).toBe("length");
    expect(Fields.catalogRevision).toBeGreaterThanOrEqual(1);
  });

  it("reads and writes by id or index", () => {
    const fields = solver().fields;
    expect(fields.get("node.max_depth", "J1")).toBe(5);
    fields.set("node.max_depth", 1, 2.5);
    expect(fields.get("node.max_depth", "O1")).toBe(2.5);
    expect(fields.getAll("node.max_depth")).toEqual([5, 2.5]);
  });

  it("reads long UTF-8 text through growing buffers", () => {
    const fields = solver().fields;
    const tag = "雨水".repeat(400);
    fields.set("node.tag", "J1", tag);
    expect(fields.get("node.tag", "J1")).toBe(tag);
  });

  it("maps engine refusals and unknown names to typed errors", () => {
    const fields = solver().fields;
    expect(() => fields.set("node.depth", "J1", 1)).toThrow(LifecycleError);
    expect(() => fields.get("node.max_depth", "NOPE")).toThrow(ElementNotFoundError);
    expect(() => fields.get("node.max_depth")).toThrow(BadParamError);
    expect(() => fields.get("node.not_a_field", "J1")).toThrow(BadParamError);
    expect(() => fields.set("node.max_depth", "J1", "deep")).toThrow(BadParamError);
  });
});
