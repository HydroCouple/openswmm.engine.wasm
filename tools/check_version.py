#!/usr/bin/env python3
"""Check that package.json's version matches the pinned engine version.

The package tracks the engine: engine 6.0.0 + OPENSWMM_PRERELEASE "alpha.4"
allows package versions 6.0.0-alpha.4 and 6.0.0-alpha.4.N (wasm-only
re-releases against the same engine). A final engine (empty prerelease)
allows 6.0.0 and 6.0.0-N.

Usage:  python3 tools/check_version.py [--engine-root DIR] [--tag vX.Y.Z]
        --tag  also require the tag to equal "v" + package.json version.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def engine_version(engine_root: Path) -> str:
    text = (engine_root / "CMakeLists.txt").read_text(encoding="utf-8")
    m = re.search(r"project\(\s*openswmm\b[^)]*?VERSION\s+(\d+\.\d+\.\d+)", text, re.S)
    if not m:
        raise SystemExit("check_version: engine project(VERSION) not found")
    pre = re.search(r'set\(OPENSWMM_PRERELEASE\s+"([^"]*)"', text)
    return m.group(1) + (f"-{pre.group(1)}" if pre and pre.group(1) else "")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine-root", default=str(ROOT / "extern" / "openswmm.engine"))
    ap.add_argument("--tag")
    a = ap.parse_args()

    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    engine = engine_version(Path(a.engine_root))
    sep = "." if "-" in engine else "-"
    allowed = re.compile(re.escape(engine) + rf"(?:{re.escape(sep)}\d+)?")
    errors = []
    if not allowed.fullmatch(package):
        errors.append(
            f"package.json version {package} does not track engine {engine} "
            f"(expected {engine} or {engine}{sep}N)"
        )
    if a.tag is not None and a.tag != f"v{package}":
        errors.append(f"tag {a.tag} does not match package.json version v{package}")
    for e in errors:
        print(f"check_version: {e}", file=sys.stderr)
    if not errors:
        print(f"check_version: package {package} tracks engine {engine}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
