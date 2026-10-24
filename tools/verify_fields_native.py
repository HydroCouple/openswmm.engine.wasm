#!/usr/bin/env python3
"""
Check src/js/fields.generated.ts against the native engine and its Python bindings.

For every generated field, read it through its C getter (ctypes, on the Python
Solver's own engine handle) and through the Python binding, on the given models,
and require identical values; for writable fields, write the value read back
through the C setter. A mismatch means the generator picked the wrong C function
or the Python property transforms the value, so the field must be hand-written.

Needs an installed native ``openswmm`` build of the same engine revision.

Usage:  python3 tools/verify_fields_native.py MODEL.inp [MODEL2.inp ...] [--out DIR]
"""

from __future__ import annotations

import argparse
import ctypes
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_fields() -> tuple[dict, dict]:
    """The generator's tables, built from the installed engine's catalog."""
    import importlib.util

    from openswmm.engine import catalog

    spec = importlib.util.spec_from_file_location("gen_fields", ROOT / "tools/gen_fields.py")
    gen = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gen)
    manifest = json.loads((ROOT / "src/js/raw.manifest.json").read_text(encoding="utf-8"))
    fields, elements, _ = gen.build(catalog.load(), manifest)
    return fields, elements


def native_lib(engine_module) -> ctypes.CDLL:
    import openswmm.engine._solver as solver_ext

    # The extension links the engine library; its symbols are reachable from the process.
    return ctypes.CDLL(solver_ext.__file__, mode=ctypes.RTLD_GLOBAL)


def c_read(lib, spec: dict, handle: int, index: int | None):
    fn = getattr(lib, spec["get"])
    args = [ctypes.c_void_p(handle)] + ([ctypes.c_int(index)] if index is not None else [])
    if spec["kind"] == "cstr":
        fn.restype = ctypes.c_char_p
        raw = fn(*args)
        return (raw or b"").decode("utf-8")
    fn.restype = ctypes.c_int
    if spec["kind"] == "num":
        out = ctypes.c_double()
    elif spec["kind"] == "int":
        out = ctypes.c_int()
    else:
        size = 1 << 16
        buf = ctypes.create_string_buffer(size)
        rc = fn(*args, buf, ctypes.c_int(size))
        return rc, buf.value.decode("utf-8")
    rc = fn(*args, ctypes.byref(out))
    return rc, out.value


def c_write(lib, spec: dict, handle: int, index: int | None, value) -> int:
    fn = getattr(lib, spec["set"])
    fn.restype = ctypes.c_int
    args = [ctypes.c_void_p(handle)] + ([ctypes.c_int(index)] if index is not None else [])
    if spec["type"] == "str":
        arg = ctypes.c_char_p(str(value).encode("utf-8"))
    elif spec["kind"] == "num":
        arg = ctypes.c_double(float(value))
    else:
        arg = ctypes.c_int(int(value))
    return fn(*args, arg)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("models", nargs="+")
    ap.add_argument("--out", default=str(ROOT / "tests/_work/verify_fields"))
    a = ap.parse_args()
    import openswmm.engine as engine
    from openswmm.engine import catalog

    fields, elements = load_fields()
    lib = native_lib(engine)
    out_dir = Path(a.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    checked, written, mismatches, skipped, verified = 0, 0, [], {}, set()
    for model in a.models:
        stem = Path(model).stem
        solver = engine.Solver(model, str(out_dir / f"{stem}.rpt"), str(out_dir / f"{stem}.out"))
        solver.open()
        try:
            handle = int(solver.handle)
            for path, spec in fields.items():
                entry = catalog.lookup(path)
                kind = spec.get("element")
                if kind is None:
                    keys = [None]
                else:
                    count = getattr(lib, elements[kind]["count"])
                    count.restype = ctypes.c_int
                    keys = list(range(int(count(ctypes.c_void_p(handle)))))
                for key in keys:
                    try:
                        owner = catalog.resolve(solver, entry["target"], key)
                        expected = getattr(owner, entry["name"])
                    except Exception as exc:  # not applicable to this element/model
                        skipped[path] = type(exc).__name__
                        continue
                    got = c_read(lib, spec, handle, key)
                    if spec["kind"] != "cstr":
                        rc, got = got
                        if rc != 0:
                            mismatches.append(
                                f"{stem}:{path}[{key}] C getter returned {rc}, "
                                f"Python gave {expected!r}"
                            )
                            continue
                    if spec["type"] == "bool":
                        got = bool(got)
                    elif spec["kind"] == "int":
                        expected = int(expected)
                    same = got == expected or (
                        isinstance(got, float)
                        and isinstance(expected, float)
                        and (
                            math.isclose(got, expected, rel_tol=0, abs_tol=0)
                            or (math.isnan(got) and math.isnan(expected))
                        )
                    )
                    checked += 1
                    verified.add(path)
                    if not same:
                        mismatches.append(f"{stem}:{path}[{key}] C={got!r} Python={expected!r}")
                        continue
                    if "set" in spec:
                        # The C setter must behave exactly like the Python setter: the same
                        # refusal (e.g. a runtime-only field while OPENED) or the same value
                        # read back (including any unit-conversion rounding).
                        rc = c_write(lib, spec, handle, key, expected)
                        after_c = getattr(
                            catalog.resolve(solver, entry["target"], key), entry["name"]
                        )
                        try:
                            setattr(
                                catalog.resolve(solver, entry["target"], key),
                                entry["name"],
                                expected,
                            )
                            refused = None
                        except Exception as exc:
                            refused = getattr(exc, "code", type(exc).__name__)
                        after_py = getattr(
                            catalog.resolve(solver, entry["target"], key), entry["name"]
                        )
                        written += 1
                        if (
                            (rc != 0) != (refused is not None)
                            or (rc == 0 and after_c != after_py)
                            or (rc != 0 and int(refused) != rc)
                        ):
                            mismatches.append(
                                f"{stem}:{path}[{key}] C setter rc={rc} -> "
                                f"{after_c!r}; Python setter refused={refused} -> "
                                f"{after_py!r}"
                            )
        finally:
            solver.close()
    report = {
        "checked": checked,
        "written": written,
        "mismatches": mismatches,
        "not_verified": {p: r for p, r in sorted(skipped.items()) if p not in verified},
    }
    (out_dir / "report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    print(
        f"verify_fields_native: {checked} reads and {written} write-backs compared, "
        f"{len(mismatches)} mismatches, {len(report['not_verified'])} fields not applicable to "
        f"these models (report: {out_dir / 'report.json'})"
    )
    for line in mismatches[:40]:
        print("  MISMATCH", line)
    return 1 if mismatches else 0


if __name__ == "__main__":
    sys.exit(main())
