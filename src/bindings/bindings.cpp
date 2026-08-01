/**
 * @file bindings.cpp
 * @brief Emscripten/Embind wrapper exposing the OpenSWMM Engine C API to
 *        JavaScript / WebAssembly.
 *
 * @details This translation unit is compiled exclusively with Emscripten.
 * It does **not** use Embind class bindings; instead it exposes the raw C
 * API functions directly via `emscripten::function()` so that the TypeScript
 * wrapper layer can call them with integer handles (pointers cast to int).
 *
 * The TypeScript layer in `src/js/` provides the idiomatic OOP surface; this
 * file's sole job is to make every C symbol reachable from JavaScript without
 * name-mangling.
 *
 * ### Why function-level Embind instead of class-level?
 * `SWMM_Engine` is an opaque `void*` handle. Wrapping it as an Embind
 * `class_<>` would require either a C++ shim class or a custom smart-pointer
 * policy. Exposing bare functions that accept/return `int` (the WASM pointer
 * size) is simpler, avoids lifetime ownership complications, and matches the
 * pattern used by the Python Cython bindings which also pass the handle as a
 * plain integer.
 *
 * @note Build with:
 * @code
 *   emcmake cmake -B build -DCMAKE_BUILD_TYPE=Release
 *   cmake --build build
 * @endcode
 *
 * @author   Caleb Buahin <caleb.buahin@gmail.com>
 * @copyright Copyright (c) 2026 Caleb Buahin. All rights reserved.
 * @license  MIT
 */

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include "openswmm/engine/openswmm_engine.h"
#include "openswmm/engine/openswmm_nodes.h"
#include "openswmm/engine/openswmm_links.h"
#include "openswmm/engine/openswmm_subcatchments.h"
#include "openswmm/engine/openswmm_gages.h"
#include "openswmm/engine/openswmm_controls.h"
#include "openswmm/engine/openswmm_forcing.h"

using namespace emscripten;

// ---------------------------------------------------------------------------
// Helper: cast between SWMM_Engine (void*) and uintptr_t / int.
// WASM is a 32-bit address space so uintptr_t == uint32_t.
// ---------------------------------------------------------------------------
static inline SWMM_Engine to_engine(int h) {
    return reinterpret_cast<SWMM_Engine>(static_cast<uintptr_t>(h));
}

static inline int from_engine(SWMM_Engine e) {
    return static_cast<int>(reinterpret_cast<uintptr_t>(e));
}

// ---------------------------------------------------------------------------
// Lifecycle wrappers
// ---------------------------------------------------------------------------

static int js_swmm_engine_create() {
    return from_engine(swmm_engine_create());
}

static int js_swmm_engine_open(int h,
                                const std::string& inp,
                                const std::string& rpt,
                                const std::string& out,
                                const std::string& plugin_lib) {
    return swmm_engine_open(to_engine(h),
                             inp.c_str(),
                             rpt.c_str(),
                             out.c_str(),
                             plugin_lib.empty() ? nullptr : plugin_lib.c_str());
}

static int  js_swmm_engine_initialize(int h)              { return swmm_engine_initialize(to_engine(h)); }
static int  js_swmm_engine_start(int h, int save)         { return swmm_engine_start(to_engine(h), save); }
static int  js_swmm_engine_end(int h)                     { return swmm_engine_end(to_engine(h)); }
static int  js_swmm_engine_report(int h)                  { return swmm_engine_report(to_engine(h)); }
static int  js_swmm_engine_close(int h)                   { return swmm_engine_close(to_engine(h)); }
static void js_swmm_engine_destroy(int h)                 { swmm_engine_destroy(to_engine(h)); }
static void js_swmm_engine_set_lenient_open(int h, int on){ swmm_engine_set_lenient_open(to_engine(h), on); }

static int  js_swmm_engine_get_state(int h, int* out)     { return swmm_engine_get_state(to_engine(h), out); }

// step/stride: elapsed out-parameter is a double* on the WASM heap
static int  js_swmm_engine_step(int h, double* elapsed)   { return swmm_engine_step(to_engine(h), elapsed); }
static int  js_swmm_engine_stride(int h, int n, double* elapsed) {
    return swmm_engine_stride(to_engine(h), n, elapsed);
}

// ---------------------------------------------------------------------------
// Error / timing
// ---------------------------------------------------------------------------

static int         js_swmm_get_last_error(int h)        { return swmm_get_last_error(to_engine(h)); }
static std::string js_swmm_get_last_error_msg(int h)    {
    const char* m = swmm_get_last_error_msg(to_engine(h));
    return m ? std::string(m) : std::string();
}
static std::string js_swmm_error_message(int code)      {
    const char* m = swmm_error_message(code);
    return m ? std::string(m) : std::string();
}
static int js_swmm_get_error_count(int h)   { return swmm_get_error_count(to_engine(h)); }
static int js_swmm_get_warning_count(int h) { return swmm_get_warning_count(to_engine(h)); }

static int js_swmm_get_start_time  (int h, double* t) { return swmm_get_start_time  (to_engine(h), t); }
static int js_swmm_get_end_time    (int h, double* t) { return swmm_get_end_time    (to_engine(h), t); }
static int js_swmm_get_current_time(int h, double* t) { return swmm_get_current_time(to_engine(h), t); }
static int js_swmm_get_routing_step(int h, double* t) { return swmm_get_routing_step(to_engine(h), t); }
static int js_swmm_get_flow_units  (int h, int* u)    { return swmm_get_flow_units  (to_engine(h), u); }
static int js_swmm_get_unit_system (int h, int* u)    { return swmm_get_unit_system (to_engine(h), u); }

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

static int         js_swmm_node_count(int h)             { return swmm_node_count(to_engine(h)); }
static int         js_swmm_node_index(int h, const std::string& id) {
    return swmm_node_index(to_engine(h), id.c_str());
}
static std::string js_swmm_node_id(int h, int idx) {
    const char* s = swmm_node_id(to_engine(h), idx);
    return s ? std::string(s) : std::string();
}

static int js_swmm_node_get_type          (int h, int i, int*    v) { return swmm_node_get_type(to_engine(h), i, v); }
static int js_swmm_node_get_depth         (int h, int i, double* v) { return swmm_node_get_depth(to_engine(h), i, v); }
static int js_swmm_node_set_depth         (int h, int i, double  v) { return swmm_node_set_depth(to_engine(h), i, v); }
static int js_swmm_node_get_head          (int h, int i, double* v) { return swmm_node_get_head(to_engine(h), i, v); }
static int js_swmm_node_get_volume        (int h, int i, double* v) { return swmm_node_get_volume(to_engine(h), i, v); }
static int js_swmm_node_get_lateral_inflow(int h, int i, double* v) { return swmm_node_get_lateral_inflow(to_engine(h), i, v); }
static int js_swmm_node_set_lateral_inflow(int h, int i, double  v) { return swmm_node_set_lateral_inflow(to_engine(h), i, v); }
static int js_swmm_node_get_overflow      (int h, int i, double* v) { return swmm_node_get_overflow(to_engine(h), i, v); }
static int js_swmm_node_get_inflow        (int h, int i, double* v) { return swmm_node_get_inflow(to_engine(h), i, v); }
static int js_swmm_node_get_losses        (int h, int i, double* v) { return swmm_node_get_losses(to_engine(h), i, v); }
static int js_swmm_node_get_outflow       (int h, int i, double* v) { return swmm_node_get_outflow(to_engine(h), i, v); }
static int js_swmm_node_get_invert_elev   (int h, int i, double* v) { return swmm_node_get_invert_elev(to_engine(h), i, v); }
static int js_swmm_node_set_invert_elev   (int h, int i, double  v) { return swmm_node_set_invert_elev(to_engine(h), i, v); }
static int js_swmm_node_get_max_depth     (int h, int i, double* v) { return swmm_node_get_max_depth(to_engine(h), i, v); }
static int js_swmm_node_set_max_depth     (int h, int i, double  v) { return swmm_node_set_max_depth(to_engine(h), i, v); }
static int js_swmm_node_set_head_boundary (int h, int i, double  v) { return swmm_node_set_head_boundary(to_engine(h), i, v); }

static int js_swmm_node_get_stat_max_depth     (int h, int i, double* v) { return swmm_node_get_stat_max_depth(to_engine(h), i, v); }
static int js_swmm_node_get_stat_max_overflow  (int h, int i, double* v) { return swmm_node_get_stat_max_overflow(to_engine(h), i, v); }
static int js_swmm_node_get_stat_vol_flooded   (int h, int i, double* v) { return swmm_node_get_stat_vol_flooded(to_engine(h), i, v); }
static int js_swmm_node_get_stat_time_flooded  (int h, int i, double* v) { return swmm_node_get_stat_time_flooded(to_engine(h), i, v); }

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

static int         js_swmm_link_count(int h)             { return swmm_link_count(to_engine(h)); }
static int         js_swmm_link_index(int h, const std::string& id) {
    return swmm_link_index(to_engine(h), id.c_str());
}
static std::string js_swmm_link_id(int h, int idx) {
    const char* s = swmm_link_id(to_engine(h), idx);
    return s ? std::string(s) : std::string();
}

static int js_swmm_link_get_type            (int h, int i, int*    v) { return swmm_link_get_type(to_engine(h), i, v); }
static int js_swmm_link_get_flow            (int h, int i, double* v) { return swmm_link_get_flow(to_engine(h), i, v); }
static int js_swmm_link_set_flow            (int h, int i, double  v) { return swmm_link_set_flow(to_engine(h), i, v); }
static int js_swmm_link_get_depth           (int h, int i, double* v) { return swmm_link_get_depth(to_engine(h), i, v); }
static int js_swmm_link_get_velocity        (int h, int i, double* v) { return swmm_link_get_velocity(to_engine(h), i, v); }
static int js_swmm_link_get_capacity        (int h, int i, double* v) { return swmm_link_get_capacity(to_engine(h), i, v); }
static int js_swmm_link_get_volume          (int h, int i, double* v) { return swmm_link_get_volume(to_engine(h), i, v); }
static int js_swmm_link_get_control_setting (int h, int i, double* v) { return swmm_link_get_control_setting(to_engine(h), i, v); }
static int js_swmm_link_set_control_setting (int h, int i, double  v) { return swmm_link_set_control_setting(to_engine(h), i, v); }
static int js_swmm_link_get_target_setting  (int h, int i, double* v) { return swmm_link_get_target_setting(to_engine(h), i, v); }
static int js_swmm_link_set_target_setting  (int h, int i, double  v) { return swmm_link_set_target_setting(to_engine(h), i, v); }
static int js_swmm_link_get_closed          (int h, int i, int*    v) { return swmm_link_get_closed(to_engine(h), i, v); }
static int js_swmm_link_set_closed          (int h, int i, int     v) { return swmm_link_set_closed(to_engine(h), i, v); }
static int js_swmm_link_get_from_node       (int h, int i, int*    v) { return swmm_link_get_from_node(to_engine(h), i, v); }
static int js_swmm_link_get_to_node         (int h, int i, int*    v) { return swmm_link_get_to_node(to_engine(h), i, v); }

// ---------------------------------------------------------------------------
// Subcatchments
// ---------------------------------------------------------------------------

static int         js_swmm_subcatch_count(int h) { return swmm_subcatch_count(to_engine(h)); }
static int         js_swmm_subcatch_index(int h, const std::string& id) {
    return swmm_subcatch_index(to_engine(h), id.c_str());
}
static std::string js_swmm_subcatch_id(int h, int idx) {
    const char* s = swmm_subcatch_id(to_engine(h), idx);
    return s ? std::string(s) : std::string();
}

static int js_swmm_subcatch_get_runoff      (int h, int i, double* v) { return swmm_subcatch_get_runoff(to_engine(h), i, v); }
static int js_swmm_subcatch_get_area        (int h, int i, double* v) { return swmm_subcatch_get_area(to_engine(h), i, v); }
static int js_swmm_subcatch_get_imperv_pct  (int h, int i, double* v) { return swmm_subcatch_get_imperv_pct(to_engine(h), i, v); }
static int js_swmm_subcatch_get_width       (int h, int i, double* v) { return swmm_subcatch_get_width(to_engine(h), i, v); }
static int js_swmm_subcatch_get_slope       (int h, int i, double* v) { return swmm_subcatch_get_slope(to_engine(h), i, v); }
static int js_swmm_subcatch_get_outlet      (int h, int i, int*    v) { return swmm_subcatch_get_outlet(to_engine(h), i, v); }
static int js_swmm_subcatch_get_gage        (int h, int i, int*    v) { return swmm_subcatch_get_gage(to_engine(h), i, v); }

// ---------------------------------------------------------------------------
// Rain gages
// ---------------------------------------------------------------------------

static int         js_swmm_gage_count(int h) { return swmm_gage_count(to_engine(h)); }
static int         js_swmm_gage_index(int h, const std::string& id) {
    return swmm_gage_index(to_engine(h), id.c_str());
}
static std::string js_swmm_gage_id(int h, int idx) {
    const char* s = swmm_gage_id(to_engine(h), idx);
    return s ? std::string(s) : std::string();
}

static int js_swmm_gage_get_rainfall      (int h, int i, double* v) { return swmm_gage_get_rainfall(to_engine(h), i, v); }
static int js_swmm_gage_set_rainfall      (int h, int i, double  v) { return swmm_gage_set_rainfall(to_engine(h), i, v); }
static int js_swmm_gage_get_rain_type     (int h, int i, int*    v) { return swmm_gage_get_rain_type(to_engine(h), i, v); }
static int js_swmm_gage_get_data_source   (int h, int i, int*    v) { return swmm_gage_get_data_source(to_engine(h), i, v); }
static int js_swmm_gage_get_scale_factor  (int h, int i, double* v) { return swmm_gage_get_scale_factor(to_engine(h), i, v); }
static int js_swmm_gage_set_scale_factor  (int h, int i, double  v) { return swmm_gage_set_scale_factor(to_engine(h), i, v); }
static int js_swmm_gage_get_rain_interval (int h, int i, double* v) { return swmm_gage_get_rain_interval(to_engine(h), i, v); }
static int js_swmm_gage_get_snow_factor   (int h, int i, double* v) { return swmm_gage_get_snow_factor(to_engine(h), i, v); }

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

static int         js_swmm_control_count(int h) { return swmm_control_count(to_engine(h)); }

static int js_swmm_control_get_rule(int h, int idx, int buf_ptr, int buflen) {
    char* buf = reinterpret_cast<char*>(static_cast<uintptr_t>(buf_ptr));
    return swmm_control_get_rule(to_engine(h), idx, buf, buflen);
}
static int js_swmm_control_get_id(int h, int idx, int buf_ptr, int buflen) {
    char* buf = reinterpret_cast<char*>(static_cast<uintptr_t>(buf_ptr));
    return swmm_control_get_id(to_engine(h), idx, buf, buflen);
}

static int js_swmm_control_add_rule(int h, const std::string& text) {
    return swmm_control_add_rule(to_engine(h), text.c_str());
}
static int js_swmm_control_remove_rule   (int h, int idx) { return swmm_control_remove_rule(to_engine(h), idx); }
static int js_swmm_control_clear_rules   (int h)          { return swmm_control_clear_rules(to_engine(h)); }
static int js_swmm_control_set_link_setting(int h, int li, double s) {
    return swmm_control_set_link_setting(to_engine(h), li, s);
}
static int js_swmm_control_set_link_status(int h, int li, int s) {
    return swmm_control_set_link_status(to_engine(h), li, s);
}

// ---------------------------------------------------------------------------
// Forcing
// ---------------------------------------------------------------------------

static int js_swmm_forcing_node_lat_inflow(int h, int ni, double v, int m) {
    return swmm_forcing_node_lat_inflow(to_engine(h), ni, v, m);
}
static int js_swmm_forcing_node_head_boundary(int h, int ni, double v, int m) {
    return swmm_forcing_node_head_boundary(to_engine(h), ni, v, m);
}
static int js_swmm_forcing_link_flow(int h, int li, double v, int m) {
    return swmm_forcing_link_flow(to_engine(h), li, v, m);
}
static int js_swmm_forcing_link_setting(int h, int li, double v, int m) {
    return swmm_forcing_link_setting(to_engine(h), li, v, m);
}
static int js_swmm_forcing_subcatch_rainfall(int h, int si, double v, int m) {
    return swmm_forcing_subcatch_rainfall(to_engine(h), si, v, m);
}
static int js_swmm_forcing_gage_rainfall(int h, int gi, double v, int m) {
    return swmm_forcing_gage_rainfall(to_engine(h), gi, v, m);
}
static int js_swmm_forcing_clear    (int h, int type, int idx) { return swmm_forcing_clear(to_engine(h), type, idx); }
static int js_swmm_forcing_clear_all(int h)                    { return swmm_forcing_clear_all(to_engine(h)); }

// ===========================================================================
// Embind registrations
// ===========================================================================

EMSCRIPTEN_BINDINGS(openswmm_engine) {

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------
    function("swmm_engine_create",           &js_swmm_engine_create);
    function("swmm_engine_open",             &js_swmm_engine_open);
    function("swmm_engine_initialize",       &js_swmm_engine_initialize);
    function("swmm_engine_start",            &js_swmm_engine_start);
    function("swmm_engine_step",             &js_swmm_engine_step,
             allow_raw_pointers());
    function("swmm_engine_stride",           &js_swmm_engine_stride,
             allow_raw_pointers());
    function("swmm_engine_end",              &js_swmm_engine_end);
    function("swmm_engine_report",           &js_swmm_engine_report);
    function("swmm_engine_close",            &js_swmm_engine_close);
    function("swmm_engine_destroy",          &js_swmm_engine_destroy);
    function("swmm_engine_set_lenient_open", &js_swmm_engine_set_lenient_open);
    function("swmm_engine_get_state",        &js_swmm_engine_get_state,
             allow_raw_pointers());

    // -----------------------------------------------------------------------
    // Error / timing
    // -----------------------------------------------------------------------
    function("swmm_get_last_error",     &js_swmm_get_last_error);
    function("swmm_get_last_error_msg", &js_swmm_get_last_error_msg);
    function("swmm_error_message",      &js_swmm_error_message);
    function("swmm_get_error_count",    &js_swmm_get_error_count);
    function("swmm_get_warning_count",  &js_swmm_get_warning_count);

    function("swmm_get_start_time",   &js_swmm_get_start_time,   allow_raw_pointers());
    function("swmm_get_end_time",     &js_swmm_get_end_time,     allow_raw_pointers());
    function("swmm_get_current_time", &js_swmm_get_current_time, allow_raw_pointers());
    function("swmm_get_routing_step", &js_swmm_get_routing_step, allow_raw_pointers());
    function("swmm_get_flow_units",   &js_swmm_get_flow_units,   allow_raw_pointers());
    function("swmm_get_unit_system",  &js_swmm_get_unit_system,  allow_raw_pointers());

    // -----------------------------------------------------------------------
    // Nodes
    // -----------------------------------------------------------------------
    function("swmm_node_count", &js_swmm_node_count);
    function("swmm_node_index", &js_swmm_node_index);
    function("swmm_node_id",    &js_swmm_node_id);

    function("swmm_node_get_type",           &js_swmm_node_get_type,           allow_raw_pointers());
    function("swmm_node_get_depth",          &js_swmm_node_get_depth,          allow_raw_pointers());
    function("swmm_node_set_depth",          &js_swmm_node_set_depth);
    function("swmm_node_get_head",           &js_swmm_node_get_head,           allow_raw_pointers());
    function("swmm_node_get_volume",         &js_swmm_node_get_volume,         allow_raw_pointers());
    function("swmm_node_get_lateral_inflow", &js_swmm_node_get_lateral_inflow, allow_raw_pointers());
    function("swmm_node_set_lateral_inflow", &js_swmm_node_set_lateral_inflow);
    function("swmm_node_get_overflow",       &js_swmm_node_get_overflow,       allow_raw_pointers());
    function("swmm_node_get_inflow",         &js_swmm_node_get_inflow,         allow_raw_pointers());
    function("swmm_node_get_losses",         &js_swmm_node_get_losses,         allow_raw_pointers());
    function("swmm_node_get_outflow",        &js_swmm_node_get_outflow,        allow_raw_pointers());
    function("swmm_node_get_invert_elev",    &js_swmm_node_get_invert_elev,    allow_raw_pointers());
    function("swmm_node_set_invert_elev",    &js_swmm_node_set_invert_elev);
    function("swmm_node_get_max_depth",      &js_swmm_node_get_max_depth,      allow_raw_pointers());
    function("swmm_node_set_max_depth",      &js_swmm_node_set_max_depth);
    function("swmm_node_set_head_boundary",  &js_swmm_node_set_head_boundary);

    function("swmm_node_get_stat_max_depth",    &js_swmm_node_get_stat_max_depth,    allow_raw_pointers());
    function("swmm_node_get_stat_max_overflow", &js_swmm_node_get_stat_max_overflow, allow_raw_pointers());
    function("swmm_node_get_stat_vol_flooded",  &js_swmm_node_get_stat_vol_flooded,  allow_raw_pointers());
    function("swmm_node_get_stat_time_flooded", &js_swmm_node_get_stat_time_flooded, allow_raw_pointers());

    // -----------------------------------------------------------------------
    // Links
    // -----------------------------------------------------------------------
    function("swmm_link_count", &js_swmm_link_count);
    function("swmm_link_index", &js_swmm_link_index);
    function("swmm_link_id",    &js_swmm_link_id);

    function("swmm_link_get_type",            &js_swmm_link_get_type,            allow_raw_pointers());
    function("swmm_link_get_flow",            &js_swmm_link_get_flow,            allow_raw_pointers());
    function("swmm_link_set_flow",            &js_swmm_link_set_flow);
    function("swmm_link_get_depth",           &js_swmm_link_get_depth,           allow_raw_pointers());
    function("swmm_link_get_velocity",        &js_swmm_link_get_velocity,        allow_raw_pointers());
    function("swmm_link_get_capacity",        &js_swmm_link_get_capacity,        allow_raw_pointers());
    function("swmm_link_get_volume",          &js_swmm_link_get_volume,          allow_raw_pointers());
    function("swmm_link_get_control_setting", &js_swmm_link_get_control_setting, allow_raw_pointers());
    function("swmm_link_set_control_setting", &js_swmm_link_set_control_setting);
    function("swmm_link_get_target_setting",  &js_swmm_link_get_target_setting,  allow_raw_pointers());
    function("swmm_link_set_target_setting",  &js_swmm_link_set_target_setting);
    function("swmm_link_get_closed",          &js_swmm_link_get_closed,          allow_raw_pointers());
    function("swmm_link_set_closed",          &js_swmm_link_set_closed);
    function("swmm_link_get_from_node",       &js_swmm_link_get_from_node,       allow_raw_pointers());
    function("swmm_link_get_to_node",         &js_swmm_link_get_to_node,         allow_raw_pointers());

    // -----------------------------------------------------------------------
    // Subcatchments
    // -----------------------------------------------------------------------
    function("swmm_subcatch_count", &js_swmm_subcatch_count);
    function("swmm_subcatch_index", &js_swmm_subcatch_index);
    function("swmm_subcatch_id",    &js_swmm_subcatch_id);

    function("swmm_subcatch_get_runoff",     &js_swmm_subcatch_get_runoff,     allow_raw_pointers());
    function("swmm_subcatch_get_area",       &js_swmm_subcatch_get_area,       allow_raw_pointers());
    function("swmm_subcatch_get_imperv_pct", &js_swmm_subcatch_get_imperv_pct, allow_raw_pointers());
    function("swmm_subcatch_get_width",      &js_swmm_subcatch_get_width,      allow_raw_pointers());
    function("swmm_subcatch_get_slope",      &js_swmm_subcatch_get_slope,      allow_raw_pointers());
    function("swmm_subcatch_get_outlet",     &js_swmm_subcatch_get_outlet,     allow_raw_pointers());
    function("swmm_subcatch_get_gage",       &js_swmm_subcatch_get_gage,       allow_raw_pointers());

    // -----------------------------------------------------------------------
    // Gages
    // -----------------------------------------------------------------------
    function("swmm_gage_count", &js_swmm_gage_count);
    function("swmm_gage_index", &js_swmm_gage_index);
    function("swmm_gage_id",    &js_swmm_gage_id);

    function("swmm_gage_get_rainfall",      &js_swmm_gage_get_rainfall,      allow_raw_pointers());
    function("swmm_gage_set_rainfall",      &js_swmm_gage_set_rainfall);
    function("swmm_gage_get_rain_type",     &js_swmm_gage_get_rain_type,     allow_raw_pointers());
    function("swmm_gage_get_data_source",   &js_swmm_gage_get_data_source,   allow_raw_pointers());
    function("swmm_gage_get_scale_factor",  &js_swmm_gage_get_scale_factor,  allow_raw_pointers());
    function("swmm_gage_set_scale_factor",  &js_swmm_gage_set_scale_factor);
    function("swmm_gage_get_rain_interval", &js_swmm_gage_get_rain_interval, allow_raw_pointers());
    function("swmm_gage_get_snow_factor",   &js_swmm_gage_get_snow_factor,   allow_raw_pointers());

    // -----------------------------------------------------------------------
    // Controls
    // -----------------------------------------------------------------------
    function("swmm_control_count",            &js_swmm_control_count);
    function("swmm_control_get_rule",         &js_swmm_control_get_rule);
    function("swmm_control_get_id",           &js_swmm_control_get_id);
    function("swmm_control_add_rule",         &js_swmm_control_add_rule);
    function("swmm_control_remove_rule",      &js_swmm_control_remove_rule);
    function("swmm_control_clear_rules",      &js_swmm_control_clear_rules);
    function("swmm_control_set_link_setting", &js_swmm_control_set_link_setting);
    function("swmm_control_set_link_status",  &js_swmm_control_set_link_status);

    // -----------------------------------------------------------------------
    // Forcing
    // -----------------------------------------------------------------------
    function("swmm_forcing_node_lat_inflow",    &js_swmm_forcing_node_lat_inflow);
    function("swmm_forcing_node_head_boundary", &js_swmm_forcing_node_head_boundary);
    function("swmm_forcing_link_flow",          &js_swmm_forcing_link_flow);
    function("swmm_forcing_link_setting",       &js_swmm_forcing_link_setting);
    function("swmm_forcing_subcatch_rainfall",  &js_swmm_forcing_subcatch_rainfall);
    function("swmm_forcing_gage_rainfall",      &js_swmm_forcing_gage_rainfall);
    function("swmm_forcing_clear",              &js_swmm_forcing_clear);
    function("swmm_forcing_clear_all",          &js_swmm_forcing_clear_all);
}
