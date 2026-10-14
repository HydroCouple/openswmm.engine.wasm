#!/usr/bin/env python3
"""Check that package.json's version matches the pinned engine's Python bindings.

The npm package carries the same qualifier as the `openswmm` Python package
built from the pinned engine (python/pyproject.toml, PEP 440), spelled in
SemVer:

    Python 6.0.0a4.dev2   ->  npm 6.0.0-alpha.4.dev.2
    Python 6.0.0a4        ->  npm 6.0.0-alpha.4
    Python 6.0.0rc1       ->  npm 6.0.0-rc.1
    Python 6.0.0          ->  npm 6.0.0

The Python version's base and pre-release must also agree with the native
engine (CMakeLists project(VERSION) + OPENSWMM_PRERELEASE), the rule the
engine's own scripts/check_version_sync.py enforces.

Usage:  python3 tools/check_version.py [--engine-root DIR] [--tag vX.Y.Z]
        --tag     also require the tag to equal "v" + package.json version.
        --expect  print the npm version the pin requires and exit.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_PHASE = {"a": "alpha", "b": "beta", "rc": "rc"}


def engine_version(engine_root: Path) -> str:
    """Native engine version as SemVer, e.g. 6.0.0-alpha.4."""
    text = (engine_root / "CMakeLists.txt").read_text(encoding="utf-8")
    m = re.search(r"project\(\s*openswmm\b[^)]*?VERSION\s+(\d+\.\d+\.\d+)", text, re.S)
    if not m:
        raise SystemExit("check_version: engine project(VERSION) not found")
    pre = re.search(r'set\(OPENSWMM_PRERELEASE\s+"([^"]*)"', text)
    return m.group(1) + (f"-{pre.group(1)}" if pre and pre.group(1) else "")


def python_version(engine_root: Path) -> str:
    """The Python bindings' [project] version, PEP 440."""
    text = (engine_root / "python" / "pyproject.toml").read_text(encoding="utf-8")
    m = re.search(r'^version\s*=\s*"([^"]+)"', text, re.M)
    if not m:
        raise SystemExit("check_version: python/pyproject.toml has no version")
    return m.group(1)


def npm_from_python(ver: str) -> tuple[str, str]:
    """PEP 440 -> (SemVer npm version, its native part without the dev qualifier)."""
    m = re.fullmatch(r"(\d+\.\d+\.\d+)(?:(a|b|rc)(\d+))?(?:\.dev(\d+))?", ver)
    if not m:
        raise SystemExit(f"check_version: unsupported Python version {ver!r}")
    base, phase, num, dev = m.groups()
    native = base + (f"-{_PHASE[phase]}.{num}" if phase else "")
    if dev is None:
        return native, native
    return native + (".dev." if phase else "-dev.") + dev, native


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine-root", default=str(ROOT / "extern" / "openswmm.engine"))
    ap.add_argument("--tag")
    ap.add_argument("--expect", action="store_true")
    a = ap.parse_args()
    root = Path(a.engine_root)

    py = python_version(root)
    expected, native = npm_from_python(py)
    if a.expect:
        print(expected)
        return 0

    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    engine = engine_version(root)
    errors = []
    if native != engine:
        errors.append(
            f"engine python/pyproject.toml {py} does not match the native engine {engine}"
        )
    if package != expected:
        errors.append(
            f"package.json version {package} must carry the Python bindings' qualifier: "
            f"{py} -> {expected}"
        )
    if a.tag is not None and a.tag != f"v{package}":
        errors.append(f"tag {a.tag} does not match package.json version v{package}")
    for e in errors:
        print(f"check_version: {e}", file=sys.stderr)
    if not errors:
        print(f"check_version: package {package} = Python {py} (engine {engine})")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
