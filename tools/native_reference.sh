#!/usr/bin/env bash
# Regenerate the native reference reports the smoke tests compare against
# (tests/fixtures/smoke.native.rpt, tests/fixtures/smoke2d.native.rpt).
#
# The reference is the native engine at the pinned submodule commit, built with
# the WASM build's arithmetic so the two agree to the printed digit:
#   * no fused multiply-add      (-ffp-contract=off; WebAssembly has no FMA)
#   * scalar kernels             (-DOPENSWMM_FORCE_SCALAR=ON)
#   * one thread                 (OMP_NUM_THREADS=1)
#   * Emscripten's musl libm     (pow/exp/log/log1p/cbrt/hypot compiled from the
#                                 emsdk musl sources and linked into the engine,
#                                 with __FP_FAST_FMA undefined as on wasm32)
# Platform libms differ from musl in the last ulp of these functions; on the
# stiff 2D deck that alone moves the 2D volumes by up to ~12 %.
#
#   tools/native_reference.sh            # build + regenerate both fixtures
#   ENGINE_ROOT=/path/to/openswmm.engine tools/native_reference.sh
#
# Needs: emsdk (for the musl sources: emcc on PATH), cmake, ninja, a native C/C++
# compiler. Build tree and logs go to tests/_work/native-reference/ (git-ignored).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE="${ENGINE_ROOT:-$ROOT/extern/openswmm.engine}"
WORK="$ROOT/tests/_work/native-reference"
MUSL="$(dirname "$(readlink -f "$(command -v emcc)")")/system/lib/libc/musl"
[[ -d "$MUSL/src/math" ]] || MUSL="$(em-config EMSCRIPTEN_ROOT)/system/lib/libc/musl"
[[ -d "$MUSL/src/math" ]] || { echo "native_reference: musl sources not found (is emsdk on PATH?)" >&2; exit 2; }

mkdir -p "$WORK/libm/stub"
FP=(-ffp-contract=off -fno-fast-math)

# 1. musl libm, compiled natively with wasm32's FMA-free code paths.
printf '#pragma once\n#define weak_alias(a,b)\n' > "$WORK/libm/stub/features.h"
printf '#pragma once\n#include <machine/endian.h>\n#define __BYTE_ORDER __DARWIN_BYTE_ORDER\n#define __LITTLE_ENDIAN __DARWIN_LITTLE_ENDIAN\n#define __BIG_ENDIAN __DARWIN_BIG_ENDIAN\n' \
    > "$WORK/libm/stub/endian.h"
OBJS=()
for f in pow pow_data exp exp_data log log_data log1p cbrt hypot \
         __math_oflow __math_uflow __math_xflow __math_invalid __math_divzero; do
    cc -c -O2 "${FP[@]}" -U__FP_FAST_FMA -U__FP_FAST_FMAF -std=gnu99 \
       '-Dhidden=__attribute__((__visibility__("hidden")))' \
       -I"$WORK/libm/stub" -I"$MUSL/src/internal" -I"$MUSL/arch/generic" \
       "$MUSL/src/math/$f.c" -o "$WORK/libm/$f.o"
    OBJS+=("$WORK/libm/$f.o")
done

# 2. Native engine CLI with the musl objects linked ahead of the system libm.
cmake -S "$ENGINE" -B "$WORK/build" -G Ninja -DCMAKE_BUILD_TYPE=Release \
    "-DCMAKE_CXX_FLAGS=${FP[*]}" "-DCMAKE_C_FLAGS=${FP[*]}" \
    "-DCMAKE_SHARED_LINKER_FLAGS=${OBJS[*]}" "-DCMAKE_EXE_LINKER_FLAGS=${OBJS[*]}" \
    -DOPENSWMM_FORCE_SCALAR=ON -DOPENSWMM_BUILD_2D=ON -DOPENSWMM_2D_HDF5_OUTPUT=OFF \
    -DOPENSWMM_WITH_HDF5=OFF -DOPENSWMM_WITH_GEOPACKAGE=OFF -DOPENSWMM_BUILD_GPU_PLUGIN=OFF \
    -DOPENSWMM_BUILD_TESTS=OFF -DOPENSWMM_BUILD_PYTHON=OFF -DOPENSWMM_INSTALL=OFF \
    > "$WORK/configure.log"
cmake --build "$WORK/build" --target openswmm --parallel > "$WORK/build.log"

# 3. Run the decks and refresh the fixtures.
export DYLD_LIBRARY_PATH="$WORK/build/src/engine:$WORK/build/src/common${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
export LD_LIBRARY_PATH="$WORK/build/src/engine:$WORK/build/src/common${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
for deck in smoke smoke2d; do
    OMP_NUM_THREADS=1 "$WORK/build/src/cli/openswmm" "$ROOT/tests/fixtures/$deck.inp" \
        "$WORK/$deck.rpt" "$WORK/$deck.out" > "$WORK/$deck.log" 2>&1
    cp "$WORK/$deck.rpt" "$ROOT/tests/fixtures/$deck.native.rpt"
done
echo "native_reference: refreshed tests/fixtures/{smoke,smoke2d}.native.rpt from $(git -C "$ENGINE" rev-parse --short HEAD)"
