#!/usr/bin/env python3
"""
Generate catalog-path field access for the TypeScript facade.

Reads   extern/openswmm.engine/python/openswmm/engine/catalog.json   (the engine's API catalog)
        src/js/raw.manifest.json                                    (from tools/gen_bindings.py)
Writes  src/js/fields.generated.ts      FIELDS / ELEMENTS tables used by src/js/Fields.ts
        tests/fixtures/facade_coverage.json   how much of the Python surface TypeScript reaches

A catalog property becomes a field when exactly one of its C symbols is a getter of a
simple shape and, if the property is writable, exactly one is a setter of the matching
shape:

  per element   int get(SWMM_Engine, int idx, double* | int* out)  /  (…, char* buf, int len)
                const char* get(SWMM_Engine, int idx)
                int set(SWMM_Engine, int idx, double | int | const char*)
  service       the same without ``idx``

and its type is ``float``, ``int``, ``bool``, ``str`` or an enum. Element fields need the
element's collection to expose ``count(SWMM_Engine)`` and ``index(SWMM_Engine, const char*)``.
Everything else (methods, tuples, records, unit-converting properties) stays hand-written.

The same paths are what the Python catalog, the MCP server and gymnasium use, so
``solver.fields.get("node.max_depth", "J1")`` reads exactly what
``catalog.lookup("node.max_depth")`` describes.

Usage:  python3 tools/gen_fields.py [--engine-root DIR] [--check]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATALOG_REL = Path("python/openswmm/engine/catalog.json")
OUT_TS = ROOT / "src/js/fields.generated.ts"
OUT_COVERAGE = ROOT / "tests/fixtures/facade_coverage.json"
MANIFEST = ROOT / "src/js/raw.manifest.json"

_OUT = {"double*": "num", "int*": "int"}
_IN = {"double", "int", "const char*"}
_SCALAR_TYPES = {"float", "int", "bool", "str"}


def _getter_kind(sig: dict, per_element: bool) -> str | None:
    ret, params = sig["ret"], [p[0] for p in sig["params"]]
    head = ["SWMM_Engine", "int"] if per_element else ["SWMM_Engine"]
    if params[: len(head)] != head:
        return None
    rest = params[len(head) :]
    if ret == "const char*" and not rest:
        return "cstr"
    if ret != "int":
        return None
    if len(rest) == 1 and rest[0] in _OUT:
        return _OUT[rest[0]]
    if rest == ["char*", "int"]:
        return "str"
    return None


def _is_setter(sig: dict, per_element: bool) -> bool:
    params = [p[0] for p in sig["params"]]
    head = ["SWMM_Engine", "int"] if per_element else ["SWMM_Engine"]
    return (
        sig["ret"] == "int"
        and params[: len(head)] == head
        and (len(params) == len(head) + 1 and params[-1] in _IN)
    )


def _element_of(targets: dict, name: str) -> str | None:
    entry = targets[name]
    while "collection" not in entry:
        parent = entry.get("parent")
        if parent is None:
            return None
        name, entry = parent, targets[parent]
    return name


def build(catalog: dict, manifest: dict) -> tuple[dict, dict, dict]:
    targets, funcs = catalog["targets"], manifest["functions"]
    enums = set(catalog["enums"])

    elements = {}
    for kind, entry in targets.items():
        collection = targets.get(entry.get("collection", ""), {})
        syms = collection.get("c", [])
        count = [
            s
            for s in syms
            if s.endswith("_count")
            and s in funcs
            and [p[0] for p in funcs[s]["params"]] == ["SWMM_Engine"]
        ]
        index = [
            s
            for s in syms
            if s.endswith("_index")
            and s in funcs
            and [p[0] for p in funcs[s]["params"]] == ["SWMM_Engine", "const char*"]
        ]
        if "collection" in entry and len(count) == 1 and len(index) == 1:
            elements[kind] = {"count": count[0], "index": index[0]}

    fields: dict[str, dict] = {}
    for m in catalog["members"]:
        target = m["target"]
        if m["form"] != "property" or "construct" in targets.get(target, {}):
            continue
        typ = m.get("type", "")
        if typ not in _SCALAR_TYPES and typ not in enums:
            continue
        kind = _element_of(targets, target)
        per_element = kind is not None
        if per_element and kind not in elements:
            continue
        if (
            not per_element
            and targets[target].get("parent") not in (None, "solver")
            and target != "solver"
        ):
            # Nested service views (heat.solar, ...) need their own owner path: hand-written.
            continue
        syms = [s for s in m["c"] if s in funcs]
        getters = [
            (s, _getter_kind(funcs[s], per_element))
            for s in syms
            if "_set_" not in s and _getter_kind(funcs[s], per_element)
        ]
        getters = [g for g in getters if not g[0].endswith(("_count", "_index"))]
        if len(getters) != 1:
            continue
        get, get_kind = getters[0]
        if (get_kind == "str" or get_kind == "cstr") != (typ == "str"):
            continue
        spec = {"get": get, "kind": get_kind, "type": typ}
        if m.get("access") == "rw":
            setters = [s for s in syms if "_set_" in s and _is_setter(funcs[s], per_element)]
            if len(setters) != 1:
                continue
            spec["set"] = setters[0]
        if per_element:
            spec["element"] = kind
        if m.get("units"):
            spec["units"] = m["units"]
        doc = (m.get("doc") or "").strip().split("\n")[0]
        spec["doc"] = doc[:200]
        fields[m["path"]] = spec

    properties = [
        m
        for m in catalog["members"]
        if m["form"] == "property" and "construct" not in targets.get(m["target"], {})
    ]
    by_target: dict[str, dict] = {}
    for m in properties:
        row = by_target.setdefault(m["target"], {"properties": 0, "fields": 0})
        row["properties"] += 1
        row["fields"] += m["path"] in fields
    coverage = {
        "note": "Generated by tools/gen_fields.py -- catalog properties reachable through "
        "solver.fields; methods and composite properties are hand-written.",
        "catalog_revision": catalog.get("revision", 1),
        "properties": len(properties),
        "fields": len(fields),
        "by_target": dict(sorted(by_target.items())),
    }
    return fields, elements, coverage


def emit_ts(fields: dict, elements: dict, revision: int) -> str:
    def obj(d: dict) -> str:
        return (
            "{ "
            + ", ".join(f"{k}: {json.dumps(v, ensure_ascii=False)}" for k, v in d.items())
            + " }"
        )

    out = [
        "/**",
        " * @file fields.generated.ts",
        " * @brief GENERATED by tools/gen_fields.py from the engine catalog — do not edit.",
        " *",
        " * Catalog fields reachable through a single C getter/setter; see {@link Fields}.",
        " */",
        "",
        "/** How a field's C getter returns its value. */",
        'export type FieldKind = "num" | "int" | "str" | "cstr";',
        "",
        "/** One catalog field and the C functions behind it. */",
        "export interface FieldSpec {",
        "  /** C getter. */",
        "  readonly get: string;",
        "  /** Getter shape: `double*`/`int*` out-parameter, `char*` buffer or returned string. */",
        "  readonly kind: FieldKind;",
        "  /** Catalog type: `float`, `int`, `bool`, `str` or an enum name. */",
        "  readonly type: string;",
        "  /** C setter, when the field is writable. */",
        "  readonly set?: string;",
        "  /** Element kind (`node`, `link`, ...) for per-element fields. */",
        "  readonly element?: string;",
        "  /** Catalog unit kind (`length`, `flow`, ...), in the model's unit system. */",
        "  readonly units?: string;",
        "  readonly doc: string;",
        "}",
        "",
        "/** Element collections: count and id-to-index functions. */",
        "export interface ElementSpec {",
        "  readonly count: string;",
        "  readonly index: string;",
        "}",
        "",
        "/** Catalog revision these tables were generated from. */",
        f"export const CATALOG_REVISION = {revision};",
        "",
        "export const ELEMENTS: Readonly<Record<string, ElementSpec>> = {",
    ]
    out += [f"  {json.dumps(k)}: {obj(v)}," for k, v in sorted(elements.items())]
    out += ["};", "", "export const FIELDS: Readonly<Record<string, FieldSpec>> = {"]
    out += [f"  {json.dumps(k)}: {obj(v)}," for k, v in sorted(fields.items())]
    out += ["};", ""]
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine-root", default=str(ROOT / "extern" / "openswmm.engine"))
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    catalog_path = Path(a.engine_root) / CATALOG_REL
    if not catalog_path.is_file():
        print(f"gen_fields: catalog not found at {catalog_path}", file=sys.stderr)
        return 2
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    fields, elements, coverage = build(catalog, manifest)
    outputs = {
        OUT_TS: emit_ts(fields, elements, catalog.get("revision", 1)),
        OUT_COVERAGE: json.dumps(coverage, indent=1) + "\n",
    }
    stale = []
    for path, content in outputs.items():
        if a.check:
            if not path.exists() or path.read_text(encoding="utf-8") != content:
                stale.append(str(path.relative_to(ROOT)))
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8", newline="\n")
    summary = (
        f"{len(fields)} of {coverage['properties']} catalog properties as fields, "
        f"{len(elements)} element kinds"
    )
    if a.check:
        if stale:
            print("gen_fields: outputs out of date, run `npm run gen`: " + ", ".join(stale))
            return 1
        print(f"gen_fields: up to date ({summary})")
        return 0
    print(f"gen_fields: {summary}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
