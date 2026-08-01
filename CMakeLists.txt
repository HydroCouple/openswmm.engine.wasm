cmake_minimum_required(VERSION 3.21)

project(openswmm_engine_wasm
    VERSION 6.0.0
    DESCRIPTION "WebAssembly bindings for the OpenSWMM Engine"
    LANGUAGES CXX C
)

# ---------------------------------------------------------------------------
# C++ standard
# ---------------------------------------------------------------------------
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# ---------------------------------------------------------------------------
# Emscripten guard
# ---------------------------------------------------------------------------
if(NOT EMSCRIPTEN)
    message(WARNING
        "openswmm.engine.wasm must be built with the Emscripten toolchain.\n"
        "Re-run cmake with:\n"
        "  emcmake cmake -B build -DCMAKE_BUILD_TYPE=Release\n"
        "  cmake --build build\n"
    )
endif()

# ---------------------------------------------------------------------------
# Engine submodule
# ---------------------------------------------------------------------------
set(ENGINE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/extern/openswmm.engine")

if(NOT EXISTS "${ENGINE_ROOT}/CMakeLists.txt")
    message(FATAL_ERROR
        "openswmm.engine submodule not found at ${ENGINE_ROOT}.\n"
        "Run: git submodule update --init --recursive\n"
    )
endif()

# Build the engine as a static library so Emscripten can link it into the
# WASM output.  Disable optional features that pull in system libraries not
# available in the Emscripten sysroot.
option(OPENSWMM_WITH_GEOPACKAGE "Build GeoPackage I/O support"     OFF)
option(OPENSWMM_BUILD_TESTS      "Build engine unit tests"           OFF)
option(OPENSWMM_BUILD_CLI        "Build command-line executable"     OFF)
option(OPENSWMM_BUILD_PYTHON     "Build Python (Cython) bindings"    OFF)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "Build static libraries for WASM" FORCE)

add_subdirectory("${ENGINE_ROOT}" engine EXCLUDE_FROM_ALL)

# ---------------------------------------------------------------------------
# Emscripten link flags
# ---------------------------------------------------------------------------
# MODULARIZE=1  — wrap the WASM module in a factory function so multiple
#                  simulations can run in parallel in the same JS heap.
# EXPORT_NAME   — the factory function name imported from the JS glue.
# EXPORTED_RUNTIME_METHODS — low-level helpers exposed to JS (used by
#                              our TS wrapper for string passing).
# ALLOW_MEMORY_GROWTH=1 — permit the WASM heap to grow; stormwater models
#                          can be large.
# FILESYSTEM=1  — required for swmm_engine_open() to read .inp/.rpt/.out
#                  through the Emscripten virtual filesystem (MEMFS/NODEFS).
# ENVIRONMENT   — targets browser and node (no worker for now).
set(WASM_LINK_FLAGS
    "-sWASM=1"
    "-sMODULARIZE=1"
    "-sEXPORT_NAME=createOpenSwmmModule"
    "-sEXPORTED_RUNTIME_METHODS=['ccall','cwrap','stringToUTF8','UTF8ToString','getValue','setValue','FS','addFunction','removeFunction']"
    "-sALLOW_MEMORY_GROWTH=1"
    "-sFILESYSTEM=1"
    "-sENVIRONMENT=web,node"
    "-sASSERTIONS=0"  # set to 1 for debugging
    "--bind"           # enable Embind
)

# Build-type-specific flags
set(WASM_LINK_FLAGS_RELEASE "-O3" "-flto")
set(WASM_LINK_FLAGS_DEBUG   "-O0" "-g3" "-sASSERTIONS=2" "-sSAFE_HEAP=1")

# ---------------------------------------------------------------------------
# Bindings target
# ---------------------------------------------------------------------------
add_executable(openswmm_wasm
    src/bindings/bindings.cpp
)

target_include_directories(openswmm_wasm PRIVATE
    "${ENGINE_ROOT}/include"
)

target_link_libraries(openswmm_wasm PRIVATE
    openswmm_engine   # static library from engine submodule
)

# Apply Emscripten link flags
foreach(flag IN LISTS WASM_LINK_FLAGS)
    target_link_options(openswmm_wasm PRIVATE "${flag}")
done

if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    foreach(flag IN LISTS WASM_LINK_FLAGS_DEBUG)
        target_link_options(openswmm_wasm PRIVATE "${flag}")
    endforeach()
else()
    foreach(flag IN LISTS WASM_LINK_FLAGS_RELEASE)
        target_link_options(openswmm_wasm PRIVATE "${flag}")
    endforeach()
endif()

# Output the .wasm + .js glue into dist/ so they ship with the npm package.
set_target_properties(openswmm_wasm PROPERTIES
    OUTPUT_NAME "openswmm_engine"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/dist"
    SUFFIX ".js"
)

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
install(
    FILES
        "${CMAKE_CURRENT_SOURCE_DIR}/dist/openswmm_engine.js"
        "${CMAKE_CURRENT_SOURCE_DIR}/dist/openswmm_engine.wasm"
    DESTINATION lib
)
