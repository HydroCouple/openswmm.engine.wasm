"""Check executable Python C-API uses against the generated WASM surface."""
import argparse
import importlib.util
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine-root", type=Path, default=ROOT / "extern/openswmm.engine")
    args = parser.parse_args()
    audit_path = args.engine_root / "python/scripts/api_drift_audit.py"
    spec = importlib.util.spec_from_file_location("engine_audit", audit_path)
    audit = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(audit)
    manifest = json.loads((ROOT / "src/js/raw.manifest.json").read_text(encoding="utf-8"))
    covered = set(manifest["functions"]) | set(manifest["excludedFunctions"])
    by_module = {}
    sources = args.engine_root / "python/openswmm/engine"
    for path in sorted([*sources.glob("*.pyx"), *sources.glob("*.pxd")]):
        names = set(re.findall(r"\b(swmm_[A-Za-z0-9_]+)\b",
                               audit.executable_cython(path.read_text(encoding="utf-8"))))
        by_module[path.name] = sorted((names & set(audit.collect_c_functions())) - covered)
    if not by_module:
        raise RuntimeError(f"No Python binding sources at {sources}")
    print(json.dumps(by_module))
    return int(any(by_module.values()))

if __name__ == "__main__":
    raise SystemExit(main())
