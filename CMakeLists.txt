cmake_minimum_required(VERSION 3.21)

project(openswmm_engine_wasm
    VERSION 6.0.0
    DESCRIPTION "WebAssembly bindings for the OpenSWMM Engine"
    LANGUAGES CXX C
)

# ---------------------------------------------------------------------------
# Emscripten guard
# ---------------------------------------------------------------------------
if(NOT EMSCRIPTEN)
    message(FATAL_ERROR
        "openswmm.engine.wasm must be configured with the Emscripten toolchain:\n"
        "  emcmake cmake -B build -DCMAKE_BUILD_TYPE=Release\n"
        "  cmake --build build --parallel\n")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

# The engine throws C++ exceptions internally (caught at the C API boundary).
# Emscripten aborts on `throw` unless exception support is enabled; use the
# native WebAssembly exception proposal (supported by Node >= 18 and all
# current browsers). Must be set for BOTH compile and link of every TU,
# including the engine submodule, hence the global flags.
set(OPENSWMM_WASM_EH_FLAG "-fwasm-exceptions")
string(APPEND CMAKE_CXX_FLAGS " ${OPENSWMM_WASM_EH_FLAG}")
string(APPEND CMAKE_C_FLAGS   " ${OPENSWMM_WASM_EH_FLAG}")
string(APPEND CMAKE_EXE_LINKER_FLAGS " ${OPENSWMM_WASM_EH_FLAG}")

# ---------------------------------------------------------------------------
# SQLite3 (for the GeoPackage module) — built from the amalgamation.
# The engine's input/geopackage/CMakeLists.txt does
#   find_package(unofficial-sqlite3 CONFIG QUIET)   # vcpkg name
# so we satisfy that lookup with a tiny generated config package.
# ---------------------------------------------------------------------------
option(OPENSWMM_WASM_GEOPACKAGE "Build the GeoPackage (SQLite) module into the WASM" ON)

if(OPENSWMM_WASM_GEOPACKAGE)
    include(FetchContent)
    set(OPENSWMM_WASM_SQLITE_VERSION 3530400)  # 3.53.4
    FetchContent_Declare(sqlite_amalgamation
        URL      "https://www.sqlite.org/2026/sqlite-amalgamation-${OPENSWMM_WASM_SQLITE_VERSION}.zip"
        URL_HASH SHA3_256=628a44cfe82c66aed1ccbbe85a562d2e33ebe64b3288981ed76285612227934e
        DOWNLOAD_EXTRACT_TIMESTAMP TRUE
    )
    FetchContent_MakeAvailable(sqlite_amalgamation)

    add_library(openswmm_wasm_sqlite3 STATIC
        "${sqlite_amalgamation_SOURCE_DIR}/sqlite3.c")
    target_include_directories(openswmm_wasm_sqlite3 PUBLIC
        "${sqlite_amalgamation_SOURCE_DIR}")
    target_compile_definitions(openswmm_wasm_sqlite3 PUBLIC
        SQLITE_ENABLE_RTREE=1           # required by the GeoPackage schema
        SQLITE_THREADSAFE=0             # single-threaded WASM build
        SQLITE_OMIT_LOAD_EXTENSION=1    # no dlopen in WASM
        SQLITE_DEFAULT_MEMSTATUS=0
        SQLITE_TEMP_STORE=3             # temp tables in memory (MEMFS anyway)
    )
    # sqlite3.c is C; keep the wasm-EH flag harmless there but silence noise.
    target_compile_options(openswmm_wasm_sqlite3 PRIVATE -w)

    # Generated CONFIG package so the engine's find_package() resolves to us.
    set(_sqlite_cfg_dir "${CMAKE_CURRENT_BINARY_DIR}/sqlite3-config")
    file(MAKE_DIRECTORY "${_sqlite_cfg_dir}")
    file(WRITE "${_sqlite_cfg_dir}/unofficial-sqlite3-config.cmake"
        "if(NOT TARGET unofficial::sqlite3::sqlite3)\n"
        "    add_library(unofficial::sqlite3::sqlite3 ALIAS openswmm_wasm_sqlite3)\n"
        "endif()\n")
    set(unofficial-sqlite3_DIR "${_sqlite_cfg_dir}" CACHE PATH "" FORCE)
endif()

# ---------------------------------------------------------------------------
# Engine submodule — 1D engine + GeoPackage; no 2D (HDF5), no GPU plugin.
# ---------------------------------------------------------------------------
set(ENGINE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/extern/openswmm.engine")
if(NOT EXISTS "${ENGINE_ROOT}/CMakeLists.txt")
    message(FATAL_ERROR
        "openswmm.engine submodule not found at ${ENGINE_ROOT}.\n"
        "Run: git submodule update --init --recursive\n")
endif()

set(OPENSWMM_WITH_GEOPACKAGE  ${OPENSWMM_WASM_GEOPACKAGE} CACHE BOOL "" FORCE)
set(OPENSWMM_BUILD_2D         OFF CACHE BOOL "" FORCE)
set(OPENSWMM_WITH_HDF5        OFF CACHE BOOL "" FORCE)
set(OPENSWMM_BUILD_GPU_PLUGIN OFF CACHE BOOL "" FORCE)
set(OPENSWMM_BUILD_TESTS      OFF CACHE BOOL "" FORCE)
set(OPENSWMM_BUILD_BENCHMARKS OFF CACHE BOOL "" FORCE)
set(OPENSWMM_BUILD_PYTHON     OFF CACHE BOOL "" FORCE)
set(OPENSWMM_INSTALL          OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS         OFF CACHE BOOL "" FORCE)

# Match the reference arithmetic unless a developer deliberately opts in.
option(OPENSWMM_FAST_XSECT_LOOKUP "Experimental cross-section lookup kernel" OFF)
option(OPENSWMM_FAST_MANNING_POW "Experimental Manning power kernel" OFF)

# EXCLUDE_FROM_ALL: only targets we link (engine, geopackage, common) get
# built — not the legacy engine, CLI, etc.
add_subdirectory("${ENGINE_ROOT}" engine EXCLUDE_FROM_ALL)

# ---------------------------------------------------------------------------
# WASM module
# ---------------------------------------------------------------------------
# No hand-written C++: the whole C API is exported by name (list generated
# from the engine headers by tools/gen_bindings.py) and called from the
# TypeScript raw layer via cwrap / direct exports. Callbacks are JS functions
# turned into C function pointers with addFunction().
add_executable(openswmm_wasm src/bindings/module.cpp)

target_include_directories(openswmm_wasm PRIVATE "${ENGINE_ROOT}/include")
target_link_libraries(openswmm_wasm PRIVATE openswmm_engine)

set(OPENSWMM_WASM_EXPORTS_FILE "${CMAKE_CURRENT_SOURCE_DIR}/src/bindings/exported_functions.json")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${OPENSWMM_WASM_EXPORTS_FILE}")

set(OPENSWMM_WASM_RUNTIME_METHODS
    "ccall,cwrap,stringToUTF8,UTF8ToString,lengthBytesUTF8,getValue,setValue,"
    "HEAP8,HEAPU8,HEAP16,HEAPU16,HEAP32,HEAPU32,HEAPF32,HEAPF64,"
    "FS,addFunction,removeFunction")
string(REPLACE ";" "" OPENSWMM_WASM_RUNTIME_METHODS "${OPENSWMM_WASM_RUNTIME_METHODS}")

target_link_options(openswmm_wasm PRIVATE
    "-sWASM=1"
    "-sMODULARIZE=1"
    "-sEXPORT_ES6=1"                            # package.json "type": "module"
    "-sEXPORT_NAME=createOpenSwmmModule"
    "-sENVIRONMENT=web,worker,node"
    "-sEXPORTED_FUNCTIONS=@${OPENSWMM_WASM_EXPORTS_FILE}"
    "-sEXPORTED_RUNTIME_METHODS=${OPENSWMM_WASM_RUNTIME_METHODS}"
    "-sALLOW_MEMORY_GROWTH=1"
    "-sINITIAL_MEMORY=64MB"
    "-sMAXIMUM_MEMORY=4GB"
    "-sSTACK_SIZE=1MB"
    "-sALLOW_TABLE_GROWTH=1"                    # addFunction() for callbacks
    "-sERROR_ON_UNDEFINED_SYMBOLS=1"            # every exported name must exist
    "-sFORCE_FILESYSTEM=1"                      # .inp/.rpt/.out via MEMFS
    "-lnodefs.js"                               # FS.mount(NODEFS) under Node
    "-sASSERTIONS=0"
    "--no-entry"                                # library module: no main()
)

if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    target_compile_options(openswmm_wasm PRIVATE -O0 -g3)
    target_link_options(openswmm_wasm PRIVATE -O0 -g3 -sASSERTIONS=2 -sSAFE_HEAP=1)
else()
    target_compile_options(openswmm_wasm PRIVATE -O3)
    target_link_options(openswmm_wasm PRIVATE -O3)
endif()

# Outputs: dist/openswmm_engine.js (ES module glue) + dist/openswmm_engine.wasm
set_target_properties(openswmm_wasm PROPERTIES
    OUTPUT_NAME "openswmm_engine"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/dist"
    SUFFIX ".js"
)
