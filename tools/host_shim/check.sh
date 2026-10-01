#!/usr/bin/env bash
# Host-compile check (no emsdk needed): regenerates the raw layer, then
# compiles the generated static_asserts and src/bindings/module.cpp natively
# against the real engine headers. Catches C-API signature drift.
#
#   npm run check:bindings
#   ENGINE_ROOT=/path/to/openswmm.engine tools/host_shim/check.sh
#
# Writes the object file to tools/host_shim/out/ (git-ignored) for inspection.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ENGINE_ROOT="${ENGINE_ROOT:-$ROOT/extern/openswmm.engine}"
CXX="${CXX:-c++}"
OUT="$HERE/out"

if [[ ! -f "$ENGINE_ROOT/include/openswmm/engine/openswmm_engine.h" ]]; then
    echo "check:bindings: engine headers not found at $ENGINE_ROOT" >&2
    echo "  run: git submodule update --init   (or set ENGINE_ROOT)" >&2
    exit 2
fi

mkdir -p "$OUT"
INC=(-I"$HERE" -I"$ENGINE_ROOT/include" -I"$ENGINE_ROOT/include/openswmm/engine"
     -I"$ENGINE_ROOT/include/openswmm/plugin_sdk")
FLAGS=(-std=c++20 -Wall -Wextra -Werror=return-type -D__EMSCRIPTEN__ -DOPENSWMM_ENGINE_STATIC)

# 1. Generated outputs are current for these headers.
python3 "$ROOT/tools/gen_bindings.py" --engine-root "$ENGINE_ROOT" --check

# 2. Every parsed prototype matches the real header (static_asserts).
"$CXX" "${FLAGS[@]}" "${INC[@]}" -c "$HERE/raw_check.cpp" -o "$OUT/raw_check.host.o"

# 3. The module TU.
"$CXX" "${FLAGS[@]}" "${INC[@]}" -c "$ROOT/src/bindings/module.cpp" -o "$OUT/module.host.o"

echo "check:bindings: OK ($ENGINE_ROOT)"
