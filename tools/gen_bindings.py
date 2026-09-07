#!/usr/bin/env python3
"""
Generate the raw WASM binding layer from the OpenSWMM Engine C API headers.

Reads   extern/openswmm.engine/include/openswmm/engine/*.h
Writes  src/bindings/exported_functions.json   -> -sEXPORTED_FUNCTIONS=@file
        src/js/raw.ts                           typed cwrap table (RawApi, bindRaw)
        src/js/raw.manifest.json                name -> signature (parity tests)
        tools/host_shim/raw_check.cpp           static_asserts: parsed == real prototypes

Usage:  python3 tools/gen_bindings.py [--engine-root DIR] [--check]
        --check  regenerate into memory and fail if committed outputs differ.

Type mapping (wasm32):
  return  int / handles / pointers -> "number";  const char* -> "string";  void -> null
  params  const char*  -> "string" (cwrap copies to a temp C string; null -> NULL)
          everything else (numbers, enums, pointers, handles, callbacks) -> "number"
Functions with no string in/out are bound directly to Module._name (no cwrap).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HEADER_DIR_REL = Path("include/openswmm/engine")

# Headers compiled out of the WASM build (-DOPENSWMM_BUILD_2D=OFF).
EXCLUDED_HEADERS = {"openswmm_2d.h", "openswmm_infil2d.h"}
# Non-API headers.
SKIP_HEADERS = {"openswmm_engine_export.h", "openswmm_callbacks.h"}

# Structs passed by pointer through the C API; field layouts are emitted so the
# TS layer can read/write them on the heap without hand-maintained offsets.
STRUCTS_OF_INTEREST = [
    "SWMM_ImpactEntry", "SWMM_ImpactReport", "SWMM_ConversionResult",
    "SWMM_ThreadInfo", "SWMM_InletDesign", "SWMM_InletUsage",
]

WASM32 = {"int": (4, 4), "double": (8, 8), "float": (4, 4), "long": (4, 4),
          "char": (1, 1), "ptr": (4, 4)}

PROTO_RE = re.compile(
    r"SWMM_ENGINE_API\s+(?P<ret>[^;{]+?)\s*(?P<name>swmm_\w+)\s*\((?P<params>[^;]*?)\)\s*;",
    re.S,
)


def strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"//[^\n]*", "", text)


def norm(t: str) -> str:
    t = " ".join(t.split())
    t = re.sub(r"\s*\*", "*", t)          # "double *" -> "double*"
    return t


def split_param(p: str) -> tuple[str, str]:
    """'const char* name' -> ('const char*', 'name'); arrays -> pointer."""
    p = p.strip()
    m = re.match(r"^(.*?)(\w+)\s*(\[[^\]]*\])?$", p)
    if not m:
        raise ValueError(f"cannot parse param {p!r}")
    typ, name, arr = m.group(1), m.group(2), m.group(3)
    typ = norm(typ)
    if arr:
        typ += "*"
    if not typ:  # unnamed parameter such as 'void'
        return norm(p), ""
    return typ, name


def js_kind(ctype: str, *, is_return: bool) -> str | None:
    if ctype == "void":
        return None if is_return else "number"
    if ctype == "const char*":
        return "string"
    return "number"


def parse_headers(header_dir: Path):
    funcs = []
    for h in sorted(header_dir.glob("*.h")):
        if h.name in SKIP_HEADERS or h.name in EXCLUDED_HEADERS:
            continue
        text = strip_comments(h.read_text())
        for m in PROTO_RE.finditer(text):
            ret = norm(m.group("ret"))
            name = m.group("name")
            raw_params = m.group("params").strip()
            params = []
            if raw_params and raw_params != "void":
                for p in raw_params.split(","):
                    typ, pname = split_param(p)
                    params.append({"name": pname, "type": typ,
                                   "kind": js_kind(typ, is_return=False)})
            funcs.append({"name": name, "header": h.name, "ret": ret,
                          "retKind": js_kind(ret, is_return=True), "params": params})
    names = [f["name"] for f in funcs]
    dupes = {n for n in names if names.count(n) > 1}
    if dupes:
        raise SystemExit(f"duplicate prototypes: {sorted(dupes)}")
    return funcs


def parse_structs(header_dir: Path):
    """Compute wasm32 layouts for the structs of interest."""
    structs = {}
    for h in sorted(header_dir.glob("*.h")):
        if h.name in EXCLUDED_HEADERS:
            continue
        text = strip_comments(h.read_text())
        for m in re.finditer(r"typedef\s+struct\s*(\w*)\s*\{(.*?)\}\s*(\w+)\s*;", text, re.S):
            sname = m.group(3)
            if sname not in STRUCTS_OF_INTEREST:
                continue
            fields = []
            offset = 0
            max_align = 1
            for decl in m.group(2).split(";"):
                decl = decl.strip()
                if not decl:
                    continue
                typ, fname = split_param(decl)
                base = "ptr" if typ.endswith("*") else typ.replace("const ", "")
                if base not in WASM32:
                    raise SystemExit(f"{sname}.{fname}: unsupported field type {typ!r}")
                size, align = WASM32[base]
                offset = (offset + align - 1) // align * align
                fields.append({"name": fname, "type": typ, "offset": offset, "size": size})
                offset += size
                max_align = max(max_align, align)
            total = (offset + max_align - 1) // max_align * max_align
            structs[sname] = {"header": h.name, "size": total, "align": max_align,
                              "fields": fields}
    missing = set(STRUCTS_OF_INTEREST) - set(structs)
    if missing:
        raise SystemExit(f"structs not found: {sorted(missing)}")
    return structs


# ---------------------------------------------------------------------------
# Emitters
# ---------------------------------------------------------------------------

def emit_exported(funcs) -> str:
    names = ["_malloc", "_free"] + ["_" + f["name"] for f in funcs]
    return json.dumps(names, indent=0) + "\n"


def ts_type(kind: str | None, *, is_return: bool) -> str:
    if kind is None:
        return "void"
    if kind == "string":
        return "string" if is_return else "string | null"
    return "number"


TS_RESERVED = {"var", "let", "const", "function", "new", "delete", "in", "of", "class",
               "default", "export", "import", "return", "this", "void", "with", "yield",
               "enum", "package", "interface", "typeof", "switch", "case", "do", "if"}


def ts_param_name(name: str, i: int) -> str:
    if not name:
        return f"a{i}"
    return name + "_" if name in TS_RESERVED else name


def emit_raw_ts(funcs, structs) -> str:
    out = []
    out.append("/**\n * @file raw.ts\n * @brief GENERATED by tools/gen_bindings.py — do not edit.\n *\n"
               " * Typed access to every exported OpenSWMM Engine C function. Pointers and\n"
               " * handles are heap offsets (numbers); `const char*` inputs are JS strings\n"
               " * (copied to a temporary C string per call; `null` passes NULL).\n */\n\n")
    out.append("/** Emscripten module surface the raw layer needs. */\n"
               "export interface RawModule {\n"
               "  cwrap(name: string, ret: string | null, args: string[]): (...a: unknown[]) => unknown;\n"
               "  [exportName: `_${string}`]: unknown;\n"
               "}\n\n")
    out.append("export interface RawApi {\n")
    for f in funcs:
        args = ", ".join(f"{ts_param_name(p['name'], i)}: {ts_type(p['kind'], is_return=False)}"
                         for i, p in enumerate(f["params"]))
        out.append(f"  /** `{f['header']}` */\n  {f['name']}({args}): {ts_type(f['retKind'], is_return=True)};\n")
    out.append("}\n\n")
    out.append("/** Bind every C function on `mod`. Direct `_name` binding when no strings are involved. */\n"
               "export function bindRaw(mod: RawModule): RawApi {\n"
               "  const api: Record<string, unknown> = {};\n"
               "  const bind = (name: string, ret: string | null, args: string[]): void => {\n"
               "    if (ret !== \"string\" && !args.includes(\"string\")) {\n"
               "      const fn = mod[`_${name}`];\n"
               "      if (typeof fn !== \"function\") throw new Error(`openswmm wasm: missing export _${name}`);\n"
               "      api[name] = fn;\n"
               "    } else {\n"
               "      api[name] = mod.cwrap(name, ret, args);\n"
               "    }\n"
               "  };\n")
    for f in funcs:
        args = json.dumps([p["kind"] for p in f["params"]])
        ret = json.dumps(f["retKind"])
        out.append(f"  bind({json.dumps(f['name'])}, {ret}, {args});\n")
    out.append("  return api as unknown as RawApi;\n}\n\n")
    out.append("/** wasm32 layouts of C structs passed through the API (byte offsets). */\n"
               "export const STRUCTS = ")
    out.append(json.dumps({k: {"size": v["size"], "fields": {fl["name"]: {"offset": fl["offset"], "type": fl["type"]}
                                                             for fl in v["fields"]}}
                           for k, v in structs.items()}, indent=2))
    out.append(" as const;\n\n")
    out.append(f"/** Number of C functions in this layer. */\nexport const RAW_FUNCTION_COUNT = {len(funcs)};\n")
    return "".join(out)


def emit_manifest(funcs, structs) -> str:
    return json.dumps({"functions": {f["name"]: {"header": f["header"], "ret": f["ret"],
                                                  "params": [[p["type"], p["name"]] for p in f["params"]]}
                                     for f in funcs},
                       "structs": structs}, indent=1) + "\n"


def emit_raw_check(funcs, structs) -> str:
    out = ["// GENERATED by tools/gen_bindings.py — do not edit.\n"
           "// Compiled natively by tools/host_shim/check.sh: every parsed prototype must\n"
           "// match the real one (signature drift => compile error), and struct layouts\n"
           "// must match the compiler's under a wasm32-like ABI check.\n"
           "#include <type_traits>\n#include <cstddef>\n#include <cstdint>\n"
           "#include \"openswmm/engine/openswmm_engine.h\"\n"]
    for h in sorted({f["header"] for f in funcs} | {s["header"] for s in structs.values()}):
        out.append(f'#include "openswmm/engine/{h}"\n')
    out.append("\n")
    for f in funcs:
        ptypes = ", ".join(p["type"] for p in f["params"]) or "void"
        out.append(f"static_assert(std::is_same_v<decltype(&{f['name']}), {f['ret']} (*)({ptypes})>, "
                   f"\"{f['name']}: prototype drift\");\n")
    out.append("\n// Struct layouts are asserted only under a 32-bit-pointer ABI (the wasm32 model).\n"
               "#if UINTPTR_MAX == 0xffffffffu\n")
    for s, v in structs.items():
        out.append(f"static_assert(sizeof({s}) == {v['size']}, \"{s}: size\");\n")
        for fl in v["fields"]:
            out.append(f"static_assert(offsetof({s}, {fl['name']}) == {fl['offset']}, \"{s}.{fl['name']}: offset\");\n")
    out.append("#endif\n")
    return "".join(out)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine-root", default=str(ROOT / "extern" / "openswmm.engine"))
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    header_dir = Path(a.engine_root) / HEADER_DIR_REL
    if not header_dir.is_dir():
        print(f"gen_bindings: headers not found at {header_dir}", file=sys.stderr)
        return 2

    funcs = parse_headers(header_dir)
    structs = parse_structs(header_dir)
    outputs = {
        ROOT / "src/bindings/exported_functions.json": emit_exported(funcs),
        ROOT / "src/js/raw.ts": emit_raw_ts(funcs, structs),
        ROOT / "src/js/raw.manifest.json": emit_manifest(funcs, structs),
        ROOT / "tools/host_shim/raw_check.cpp": emit_raw_check(funcs, structs),
    }
    stale = []
    for path, content in outputs.items():
        if a.check:
            if not path.exists() or path.read_text() != content:
                stale.append(path.relative_to(ROOT))
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
    if a.check:
        if stale:
            print("gen_bindings: outputs out of date, run `npm run gen`: " + ", ".join(map(str, stale)))
            return 1
        print(f"gen_bindings: up to date ({len(funcs)} functions, {len(structs)} structs)")
        return 0
    by_header = {}
    for f in funcs:
        by_header[f["header"]] = by_header.get(f["header"], 0) + 1
    print(f"gen_bindings: {len(funcs)} functions from {len(by_header)} headers, {len(structs)} structs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
