// openswmm.engine.wasm — module translation unit.
//
// Intentionally (almost) empty: the whole OpenSWMM C API is exported by name
// through -sEXPORTED_FUNCTIONS (src/bindings/exported_functions.json, generated
// by tools/gen_bindings.py) and driven from TypeScript (src/js/raw.ts).
// Callbacks are JS functions converted with Module.addFunction().
//
// Having a real TU here keeps the target a normal C++ executable for CMake
// and gives one place for future Emscripten-only glue if it is ever needed.
#include <emscripten/emscripten.h>

extern "C" EMSCRIPTEN_KEEPALIVE const char* openswmm_wasm_abi(void) {
    return "openswmm.engine.wasm raw-abi 1";
}
