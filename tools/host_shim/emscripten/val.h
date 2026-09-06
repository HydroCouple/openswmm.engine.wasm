/** @file val.h  Host-compile stub for <emscripten/val.h> (see bind.h). */
#ifndef OPENSWMM_WASM_HOST_SHIM_VAL_H
#define OPENSWMM_WASM_HOST_SHIM_VAL_H

#include <cstddef>
#include <string>

namespace emscripten {

class val {
public:
    val() = default;
    template <typename T> explicit val(T) {}
    static val undefined() { return val(); }
    static val null() { return val(); }
    static val global(const char* = nullptr) { return val(); }
    static val module_property(const char*) { return val(); }
    template <typename T> T as() const { return T(); }
    template <typename... A> val operator()(A...) const { return val(); }
    template <typename... A> val call(const char*, A...) const { return val(); }
    val operator[](const char*) const { return val(); }
    bool isUndefined() const { return true; }
    bool isNull() const { return true; }
};

template <typename T>
inline val typed_memory_view(std::size_t, const T*) { return val(); }

}  // namespace emscripten

#endif /* OPENSWMM_WASM_HOST_SHIM_VAL_H */
