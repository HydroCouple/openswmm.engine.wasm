#!/usr/bin/env bash
# Host-compile check: type-checks src/bindings/bindings.cpp against the real
# engine C headers with a native compiler and stub Emscripten headers.
# Catches C-API signature drift without needing emsdk.
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
"$CXX" -std=c++20 -Wall -Wextra -Werror=return-type \
    -D__EMSCRIPTEN__ -DOPENSWMM_ENGINE_STATIC \
    -I"$HERE" \
    -I"$ENGINE_ROOT/include" \
    -I"$ENGINE_ROOT/include/openswmm/engine" \
    -I"$ENGINE_ROOT/include/openswmm/plugin_sdk" \
    -c "$ROOT/src/bindings/bindings.cpp" -o "$OUT/bindings.host.o"

echo "check:bindings: OK ($ENGINE_ROOT)"
