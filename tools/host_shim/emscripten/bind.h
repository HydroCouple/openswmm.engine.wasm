/**
 * @file bind.h
 * @brief Host-compile stub for <emscripten/bind.h>.
 *
 * @details Lets `src/bindings/bindings.cpp` be compiled with a native C++
 * compiler (no Emscripten) purely to type-check every call into the engine
 * C API against the real headers — the same signature drift that would
 * break the Emscripten build. Nothing here is executed.
 *
 * Usage: `npm run check:bindings` (see tools/host_shim/check.sh).
 */
#ifndef OPENSWMM_WASM_HOST_SHIM_BIND_H
#define OPENSWMM_WASM_HOST_SHIM_BIND_H

#include <string>
#include <vector>

namespace emscripten {

struct allow_raw_pointers {};

template <typename Fn, typename... Policies>
inline void function(const char*, Fn, Policies...) {}

template <typename T>
struct register_vector_t {
    template <typename... A> register_vector_t& function(A...) { return *this; }
};
template <typename T>
inline register_vector_t<T> register_vector(const char*) { return {}; }

namespace internal {
struct binding_registrar {
    template <typename F> explicit binding_registrar(F f) { (void)f; }
};
}  // namespace internal

}  // namespace emscripten

#define EMSCRIPTEN_BINDINGS(name)                                              \
    static void openswmm_wasm_bindings_##name();                               \
    static emscripten::internal::binding_registrar                             \
        openswmm_wasm_bindings_##name##_registrar(                             \
            &openswmm_wasm_bindings_##name);                                   \
    static void openswmm_wasm_bindings_##name()

#endif /* OPENSWMM_WASM_HOST_SHIM_BIND_H */
