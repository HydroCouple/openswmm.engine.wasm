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
# CMake 4.2.0–4.2.5 and 4.3.0–4.3.2 mark Emscripten as unable to link shared libraries,
# and the engine tree declares its legacy shared library unconditionally. Only the
# static engine goes into openswmm_wasm, so let configure accept the declaration.
set_property(GLOBAL PROPERTY TARGET_SUPPORTS_SHARED_LIBS TRUE)

set(OPENSWMM_WASM_EH_FLAG "-fwasm-exceptions")
string(APPEND CMAKE_CXX_FLAGS " ${OPENSWMM_WASM_EH_FLAG}")
string(APPEND CMAKE_C_FLAGS   " ${OPENSWMM_WASM_EH_FLAG}")
string(APPEND CMAKE_EXE_LINKER_FLAGS " ${OPENSWMM_WASM_EH_FLAG}")

# Multi-threaded variant: WebAssembly threads (pthreads over SharedArrayBuffer) plus
# Emscripten's OpenMP runtime, so the engine's `#pragma omp` solver loops run on
# every core the page may use. The page must be crossOriginIsolated (COOP/COEP) for
# SharedArrayBuffer; the single-threaded build stays the fallback. Every object,
# including the HDF5 and SQLite builds below, must carry -pthread, or linking a
# shared memory is refused.
option(OPENSWMM_WASM_THREADS "Build with WebAssembly threads and OpenMP" OFF)
if(OPENSWMM_WASM_THREADS)
    string(APPEND CMAKE_CXX_FLAGS " -pthread -fopenmp")
    string(APPEND CMAKE_C_FLAGS   " -pthread")
    string(APPEND CMAKE_EXE_LINKER_FLAGS " -pthread -fopenmp")
    # FindOpenMP's probe under Emscripten records the probe's whole implicit system
    # library list (a debug, legacy-exception libc++abi among them) as the OpenMP
    # libraries, which then contradicts -fwasm-exceptions at link time. emcc links
    # libomp from -fopenmp alone, so hand the engine's find_package(OpenMP) the
    # flags directly and no library names.
    foreach(lang C CXX)
        set(OpenMP_${lang}_FLAGS "-fopenmp" CACHE STRING "OpenMP flags for Emscripten" FORCE)
        set(OpenMP_${lang}_LIB_NAMES "" CACHE STRING "OpenMP libraries for Emscripten (none: emcc adds libomp)" FORCE)
    endforeach()
endif()

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
# HDF5 (2D results file, .h5 model I/O, HDF5 checkpoints) — built from source.
# The engine resolves find_package(hdf5 CONFIG) while it is configured and
# links hdf5::hdf5-static, so HDF5 is configured, built and installed here,
# during our own configure, with the same toolchain. The install directory is
# keyed on the version and options below, so changing either rebuilds it.
# Same release and archive as the native engine's vcpkg port (hdf5 2.1.1), and
# like it without zlib or szip: the engine compresses datasets whenever deflate
# is available, and a native engine built from vcpkg could not read them.
# C library only, not thread-safe (single-threaded WASM).
# ---------------------------------------------------------------------------
option(OPENSWMM_WASM_HDF5 "Build HDF5 (2D results, .h5 models, checkpoints) into the WASM" ON)

if(OPENSWMM_WASM_HDF5)
    set(OPENSWMM_WASM_HDF5_VERSION 2.1.1)
    set(_hdf5_options
        -DCMAKE_BUILD_TYPE=Release
        "-DCMAKE_C_FLAGS=${CMAKE_C_FLAGS}"   # wasm-EH, and -pthread for the threaded variant
        -DHDF_PACKAGE_NAMESPACE:STRING=hdf5::
        -DBUILD_SHARED_LIBS=OFF -DBUILD_STATIC_LIBS=ON -DBUILD_TESTING=OFF
        -DHDF5_BUILD_EXAMPLES=OFF -DHDF5_BUILD_TOOLS=OFF -DHDF5_BUILD_HL_LIB=OFF
        -DHDF5_BUILD_CPP_LIB=OFF -DHDF5_BUILD_FORTRAN=OFF -DHDF5_BUILD_JAVA=OFF
        -DHDF5_ENABLE_THREADSAFE=OFF -DHDF5_ENABLE_ZLIB_SUPPORT=OFF -DHDF5_ENABLE_SZIP_SUPPORT=OFF)
    string(SHA1 _hdf5_key "${OPENSWMM_WASM_HDF5_VERSION};${_hdf5_options}")
    string(SUBSTRING "${_hdf5_key}" 0 12 _hdf5_key)
    set(_hdf5_root "${CMAKE_CURRENT_BINARY_DIR}/_deps/hdf5")
    set(_hdf5_build "${_hdf5_root}/build-${_hdf5_key}")
    set(_hdf5_install "${_hdf5_root}/install-${_hdf5_key}")
    if(NOT EXISTS "${_hdf5_install}/cmake/hdf5-config.cmake")
        set(_hdf5_archive "${_hdf5_root}/hdf5-${OPENSWMM_WASM_HDF5_VERSION}.tar.gz")
        set(_hdf5_source "${_hdf5_root}/src/hdf5-${OPENSWMM_WASM_HDF5_VERSION}")
        message(STATUS "HDF5 ${OPENSWMM_WASM_HDF5_VERSION}: building for WASM in ${_hdf5_build}")
        if(NOT EXISTS "${_hdf5_source}/CMakeLists.txt")
            file(DOWNLOAD
                "https://github.com/HDFGroup/hdf5/archive/refs/tags/${OPENSWMM_WASM_HDF5_VERSION}.tar.gz"
                "${_hdf5_archive}"
                EXPECTED_HASH SHA512=45844e2f0e89b5a0291c9fecd9b4b663eed1a7a21b38e358fd6f6198fe509c19bcf91651d1ae3b4cf8de7445f7a71854acdb1635b939b6d08fdaf6b6c0e396d1
                STATUS _hdf5_status)
            list(GET _hdf5_status 0 _hdf5_rc)
            if(NOT _hdf5_rc EQUAL 0)
                message(FATAL_ERROR "HDF5 download failed: ${_hdf5_status}")
            endif()
            file(ARCHIVE_EXTRACT INPUT "${_hdf5_archive}" DESTINATION "${_hdf5_root}/src")
        endif()

        function(_openswmm_hdf5_step name)
            execute_process(COMMAND ${ARGN}
                OUTPUT_FILE "${_hdf5_build}-${name}.log"
                ERROR_FILE "${_hdf5_build}-${name}.log"
                RESULT_VARIABLE rc)
            if(NOT rc EQUAL 0)
                message(FATAL_ERROR "HDF5 ${name} failed (${rc}); see ${_hdf5_build}-${name}.log")
            endif()
        endfunction()
        _openswmm_hdf5_step(configure "${CMAKE_COMMAND}"
            -S "${_hdf5_source}" -B "${_hdf5_build}" -G "${CMAKE_GENERATOR}"
            "-DCMAKE_TOOLCHAIN_FILE=${CMAKE_TOOLCHAIN_FILE}"
            "-DCMAKE_CROSSCOMPILING_EMULATOR=${CMAKE_CROSSCOMPILING_EMULATOR}"
            "-DCMAKE_INSTALL_PREFIX=${_hdf5_install}"
            ${_hdf5_options})
        _openswmm_hdf5_step(build "${CMAKE_COMMAND}" --build "${_hdf5_build}" --parallel 4)
        _openswmm_hdf5_step(install "${CMAKE_COMMAND}" --install "${_hdf5_build}")
    endif()
    set(hdf5_DIR "${_hdf5_install}/cmake" CACHE PATH "" FORCE)
endif()

# ---------------------------------------------------------------------------
# Engine submodule — 1D + 2D engine + GeoPackage + HDF5; no GPU plugin.
# ---------------------------------------------------------------------------
# With OPENSWMM_WASM_HDF5 (default) the 2D module writes its [2D_OPTIONS]
# OUTPUT_FILE results, swmm_output2d_* reads them back, and .h5 models and
# HDF5 checkpoints work. Without it the engine ignores OUTPUT_FILE with a
# warning and 2D results are read only through the swmm_2d_* API (Surface2D
# in the TypeScript layer).
option(OPENSWMM_WASM_2D "Build the 2D surface module into the WASM" ON)

set(ENGINE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/extern/openswmm.engine")
if(NOT EXISTS "${ENGINE_ROOT}/CMakeLists.txt")
    message(FATAL_ERROR
        "openswmm.engine submodule not found at ${ENGINE_ROOT}.\n"
        "Run: git submodule update --init --recursive\n")
endif()
if(OPENSWMM_WASM_2D)
    file(READ "${ENGINE_ROOT}/CMakeLists.txt" _engine_root_cmake)
    if(NOT _engine_root_cmake MATCHES "OPENSWMM_2D_HDF5_OUTPUT")
        message(FATAL_ERROR
            "The engine submodule predates OPENSWMM_2D_HDF5_OUTPUT, so its 2D "
            "module needs HDF5. Bump extern/openswmm.engine, or configure with "
            "-DOPENSWMM_WASM_2D=OFF.")
    endif()
endif()

set(OPENSWMM_WITH_GEOPACKAGE  ${OPENSWMM_WASM_GEOPACKAGE} CACHE BOOL "" FORCE)
set(OPENSWMM_BUILD_2D         ${OPENSWMM_WASM_2D} CACHE BOOL "" FORCE)
set(OPENSWMM_2D_HDF5_OUTPUT   ${OPENSWMM_WASM_HDF5} CACHE BOOL "" FORCE)
set(OPENSWMM_WITH_HDF5        ${OPENSWMM_WASM_HDF5} CACHE BOOL "" FORCE)
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

# Both export lists are generated by tools/gen_bindings.py; the 1D one omits
# the 2D headers' functions, which a build without 2D cannot provide.
if(OPENSWMM_WASM_2D)
    set(OPENSWMM_WASM_EXPORTS_FILE "${CMAKE_CURRENT_SOURCE_DIR}/src/bindings/exported_functions.json")
else()
    set(OPENSWMM_WASM_EXPORTS_FILE "${CMAKE_CURRENT_SOURCE_DIR}/src/bindings/exported_functions.no2d.json")
endif()
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${OPENSWMM_WASM_EXPORTS_FILE}")

set(OPENSWMM_WASM_RUNTIME_METHODS
    "ccall,cwrap,stringToUTF8,UTF8ToString,lengthBytesUTF8,getValue,setValue,"
    "HEAP8,HEAPU8,HEAP16,HEAPU16,HEAP32,HEAPU32,HEAPF32,HEAPF64,"
    "FS,addFunction,removeFunction,ENV")   # ENV: engine/OpenMP tuning variables from JS (preRun)
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
if(OPENSWMM_WASM_THREADS)
    # Workers for the OpenMP team are created up front, one per logical core.
    target_link_options(openswmm_wasm PRIVATE
        "-sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency"
        "-sPTHREAD_POOL_SIZE_STRICT=0")
endif()

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
