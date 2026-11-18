"""Write the pinned engine's public Python surface for the TypeScript parity gate.

Reads ``openswmm.engine``'s ``.pyi`` stubs through the engine's own
``python/scripts/python_surface.py`` (``collect``), and adds the pure-Python
modules that have no stub (``_report.py``, ``_results.py``, ``catalog.py``, ...)
through the same AST reader (``stub_surface``). Writes
``tests/fixtures/python_surface.json``; ``tests/parity.test.ts`` checks every
member against the TypeScript classes, using ``tools/python_surface_map.json``
for aliases, exclusions and modules still pending a facade wave.

    python3 tools/gen_python_surface.py            # regenerate
    python3 tools/gen_python_surface.py --check    # exit 1 when stale
"""

import argparse
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "tests/fixtures/python_surface.json"


def load_collector(engine_root: Path):
    path = engine_root / "python/scripts/python_surface.py"
    spec = importlib.util.spec_from_file_location("engine_python_surface", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build(engine_root: Path) -> str:
    collector = load_collector(engine_root)
    package = engine_root / "python/openswmm/engine"
    surface = collector.collect(package)
    if not surface:
        raise RuntimeError(f"No .pyi stubs at {package}")
    for source in sorted(package.glob("*.py")):
        if source.stem != "__init__" and not source.with_suffix(".pyi").exists():
            surface[source.stem] = collector.stub_surface(source)
    return json.dumps(dict(sorted(surface.items())), indent=1, sort_keys=True) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine-root", type=Path, default=ROOT / "extern/openswmm.engine")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    text = build(args.engine_root)
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_text(encoding="utf-8") != text:
            print(
                "gen_python_surface: tests/fixtures/python_surface.json is stale, run `npm run gen`"
            )
            return 1
        print("gen_python_surface: up to date")
        return 0
    OUTPUT.write_text(text, encoding="utf-8", newline="\n")
    print(f"gen_python_surface: wrote {OUTPUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
