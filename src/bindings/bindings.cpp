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
#include "openswmm/engine/openswmm_model.h"
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

// ---------------------------------------------------------------------------
// Model builder — engine creation
// ---------------------------------------------------------------------------

static int js_swmm_engine_new() { return from_engine(swmm_engine_new()); }

// ---------------------------------------------------------------------------
// Model builder — finalisation / validation / write
// ---------------------------------------------------------------------------

static int         js_swmm_validate_model(int h)                           { return swmm_validate_model(to_engine(h)); }
static int         js_swmm_finalize_model(int h)                           { return swmm_finalize_model(to_engine(h)); }
static int         js_swmm_model_write(int h, const std::string& path)     { return swmm_model_write(to_engine(h), path.c_str()); }
static int         js_swmm_model_write_with_plugin(int h, const std::string& path, const std::string& plugin_id) {
    return swmm_model_write_with_plugin(to_engine(h), path.c_str(),
                                        plugin_id.empty() ? nullptr : plugin_id.c_str());
}

// ---------------------------------------------------------------------------
// Model builder — node / link / subcatchment / gage add & pop
// ---------------------------------------------------------------------------

static int js_swmm_node_add     (int h, const std::string& id, int type) { return swmm_node_add(to_engine(h), id.c_str(), type); }
static int js_swmm_node_pop_last(int h, const std::string& id)           { return swmm_node_pop_last(to_engine(h), id.c_str()); }

static int js_swmm_link_add     (int h, const std::string& id, int type) { return swmm_link_add(to_engine(h), id.c_str(), type); }
static int js_swmm_link_pop_last(int h, const std::string& id)           { return swmm_link_pop_last(to_engine(h), id.c_str()); }

static int js_swmm_subcatch_add(int h, const std::string& id) { return swmm_subcatch_add(to_engine(h), id.c_str()); }
static int js_swmm_gage_add    (int h, const std::string& id) { return swmm_gage_add(to_engine(h), id.c_str()); }

// ---------------------------------------------------------------------------
// Model builder — link geometry setters
// ---------------------------------------------------------------------------

static int js_swmm_link_set_nodes    (int h, int i, int from_node, int to_node) {
    return swmm_link_set_nodes(to_engine(h), i, from_node, to_node);
}
static int js_swmm_link_set_length   (int h, int i, double v) { return swmm_link_set_length(to_engine(h), i, v); }
static int js_swmm_link_set_roughness(int h, int i, double v) { return swmm_link_set_roughness(to_engine(h), i, v); }
static int js_swmm_link_set_xsect   (int h, int i, int shape,
                                       double g1, double g2, double g3, double g4) {
    return swmm_link_set_xsect(to_engine(h), i, shape, g1, g2, g3, g4);
}

// ---------------------------------------------------------------------------
// Model builder — [TITLE] section
// ---------------------------------------------------------------------------

static int         js_swmm_title_get_count(int h, int* count)             { return swmm_title_get_count(to_engine(h), count); }
static std::string js_swmm_title_get_line (int h, int index) {
    char buf[4096];
    if (swmm_title_get_line(to_engine(h), index, buf, (int)sizeof(buf)) != 0)
        return std::string();
    return std::string(buf);
}
static int js_swmm_title_add_line(int h, const std::string& line) { return swmm_title_add_line(to_engine(h), line.c_str()); }
static int js_swmm_title_set     (int h, const std::string& text) { return swmm_title_set(to_engine(h), text.c_str()); }
static int js_swmm_title_clear   (int h)                          { return swmm_title_clear(to_engine(h)); }

// ---------------------------------------------------------------------------
// Model builder — [OPTIONS] / CRS
// ---------------------------------------------------------------------------

static std::string js_swmm_options_get    (int h, const std::string& key) {
    char buf[512];
    if (swmm_options_get(to_engine(h), key.c_str(), buf, (int)sizeof(buf)) != 0)
        return std::string();
    return std::string(buf);
}
static int         js_swmm_options_set    (int h, const std::string& key, const std::string& val) {
    return swmm_options_set(to_engine(h), key.c_str(), val.c_str());
}
static std::string js_swmm_options_get_ext(int h, const std::string& key) {
    char buf[512];
    if (swmm_options_get_ext(to_engine(h), key.c_str(), buf, (int)sizeof(buf)) != 0)
        return std::string();
    return std::string(buf);
}
static int         js_swmm_options_set_ext(int h, const std::string& key, const std::string& val) {
    return swmm_options_set_ext(to_engine(h), key.c_str(), val.c_str());
}
static std::string js_swmm_get_crs        (int h) {
    char buf[512];
    if (swmm_get_crs(to_engine(h), buf, (int)sizeof(buf)) != 0)
        return std::string();
    return std::string(buf);
}

// ---------------------------------------------------------------------------
// Model builder — typed date/time options
// ---------------------------------------------------------------------------

static int js_swmm_options_get_start_date  (int h, double* t) { return swmm_options_get_start_date  (to_engine(h), t); }
static int js_swmm_options_set_start_date  (int h, double  t) { return swmm_options_set_start_date  (to_engine(h), t); }
static int js_swmm_options_get_end_date    (int h, double* t) { return swmm_options_get_end_date    (to_engine(h), t); }
static int js_swmm_options_set_end_date    (int h, double  t) { return swmm_options_set_end_date    (to_engine(h), t); }
static int js_swmm_options_get_report_start(int h, double* t) { return swmm_options_get_report_start(to_engine(h), t); }
static int js_swmm_options_set_report_start(int h, double  t) { return swmm_options_set_report_start(to_engine(h), t); }

// ---------------------------------------------------------------------------
// Model builder — user flags (schema-level)
// ---------------------------------------------------------------------------

static int js_swmm_userflag_get_bool(int h, const std::string& n, int*    v) { return swmm_userflag_get_bool(to_engine(h), n.c_str(), v); }
static int js_swmm_userflag_get_int (int h, const std::string& n, int*    v) { return swmm_userflag_get_int (to_engine(h), n.c_str(), v); }
static int js_swmm_userflag_get_real(int h, const std::string& n, double* v) { return swmm_userflag_get_real(to_engine(h), n.c_str(), v); }
static int js_swmm_userflag_set_bool(int h, const std::string& n, int    v)  { return swmm_userflag_set_bool(to_engine(h), n.c_str(), v); }
static int js_swmm_userflag_set_int (int h, const std::string& n, int    v)  { return swmm_userflag_set_int (to_engine(h), n.c_str(), v); }
static int js_swmm_userflag_set_real(int h, const std::string& n, double v)  { return swmm_userflag_set_real(to_engine(h), n.c_str(), v); }

static int js_swmm_userflag_def_count(int h, int* count) { return swmm_userflag_def_count(to_engine(h), count); }

// swmm_userflag_def_get: name_buf, type, desc_buf as WASM raw ptrs
static int js_swmm_userflag_def_get(int h, int index,
                                     int name_buf, int name_buflen,
                                     int type_ptr,
                                     int desc_buf, int desc_buflen) {
    char* nb = reinterpret_cast<char*>(static_cast<uintptr_t>(name_buf));
    int*  tp = reinterpret_cast<int* >(static_cast<uintptr_t>(type_ptr));
    char* db = reinterpret_cast<char*>(static_cast<uintptr_t>(desc_buf));
    return swmm_userflag_def_get(to_engine(h), index, nb, name_buflen, tp, db, desc_buflen);
}
static int js_swmm_userflag_define  (int h, const std::string& n, int type, const std::string& desc) {
    return swmm_userflag_define(to_engine(h), n.c_str(), type, desc.c_str());
}
static int js_swmm_userflag_undefine(int h, const std::string& n) { return swmm_userflag_undefine(to_engine(h), n.c_str()); }

// ---------------------------------------------------------------------------
// Model builder — user flag per-object values
// ---------------------------------------------------------------------------

// swmm_userflag_value_get: buf / buflen as WASM raw ptr; found as WASM int*
static int js_swmm_userflag_value_get(int h,
                                       const std::string& obj_type,
                                       const std::string& obj_name,
                                       const std::string& flag_name,
                                       int buf, int buflen, int found_ptr) {
    char* b = reinterpret_cast<char*>(static_cast<uintptr_t>(buf));
    int*  f = reinterpret_cast<int* >(static_cast<uintptr_t>(found_ptr));
    return swmm_userflag_value_get(to_engine(h),
                                    obj_type.c_str(), obj_name.c_str(), flag_name.c_str(),
                                    b, buflen, f);
}
static int js_swmm_userflag_value_set(int h,
                                       const std::string& obj_type,
                                       const std::string& obj_name,
                                       const std::string& flag_name,
                                       const std::string& value) {
    return swmm_userflag_value_set(to_engine(h),
                                    obj_type.c_str(), obj_name.c_str(),
                                    flag_name.c_str(), value.c_str());
}
static int js_swmm_userflag_value_clear(int h,
                                         const std::string& obj_type,
                                         const std::string& obj_name,
                                         const std::string& flag_name) {
    return swmm_userflag_value_clear(to_engine(h),
                                      obj_type.c_str(), obj_name.c_str(), flag_name.c_str());
}

// ---------------------------------------------------------------------------
// Model builder — [PLUGINS] section
// ---------------------------------------------------------------------------

static int js_swmm_plugins_count(int h, int* count) { return swmm_plugins_count(to_engine(h), count); }

// swmm_plugin_get: path_buf/args_buf as WASM raw ptrs
static int js_swmm_plugin_get(int h, int idx,
                               int path_buf, int path_sz,
                               int args_buf, int args_sz) {
    char* pb = reinterpret_cast<char*>(static_cast<uintptr_t>(path_buf));
    char* ab = reinterpret_cast<char*>(static_cast<uintptr_t>(args_buf));
    return swmm_plugin_get(to_engine(h), idx, pb, path_sz, ab, args_sz);
}
static int js_swmm_plugin_set   (int h, const std::string& path_or_id, const std::string& args) {
    return swmm_plugin_set(to_engine(h), path_or_id.c_str(), args.c_str());
}
static int js_swmm_plugin_remove(int h, const std::string& path_or_id) {
    return swmm_plugin_remove(to_engine(h), path_or_id.c_str());
}

// ---------------------------------------------------------------------------
// Model builder — [FILES] section
// ---------------------------------------------------------------------------

static std::string js_swmm_files_get(int h, const std::string& key) {
    char buf[1024];
    if (swmm_files_get(to_engine(h), key.c_str(), buf, (int)sizeof(buf)) != 0)
        return std::string();
    return std::string(buf);
}
static int js_swmm_files_set(int h, const std::string& key, const std::string& value) {
    return swmm_files_set(to_engine(h), key.c_str(), value.c_str());
}

// ---------------------------------------------------------------------------
// Model builder — external file path slots (IO-9)
// ---------------------------------------------------------------------------

// swmm_file_path_get: abs_buf / orig_buf as WASM raw ptrs
static int js_swmm_file_path_get(int h, int role, const std::string& owner,
                                  int abs_buf, int abs_sz,
                                  int orig_buf, int orig_sz) {
    char* ab = reinterpret_cast<char*>(static_cast<uintptr_t>(abs_buf));
    char* ob = reinterpret_cast<char*>(static_cast<uintptr_t>(orig_buf));
    return swmm_file_path_get(to_engine(h),
                               static_cast<SWMM_FilePathRole>(role),
                               owner.empty() ? nullptr : owner.c_str(),
                               ab, abs_sz, ob, orig_sz);
}
static int js_swmm_file_path_set(int h, int role, const std::string& owner,
                                  const std::string& new_path) {
    return swmm_file_path_set(to_engine(h),
                               static_cast<SWMM_FilePathRole>(role),
                               owner.empty() ? nullptr : owner.c_str(),
                               new_path.c_str());
}

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

    // -----------------------------------------------------------------------
    // Model builder — lifecycle
    // -----------------------------------------------------------------------
    function("swmm_engine_new",              &js_swmm_engine_new);
    function("swmm_validate_model",          &js_swmm_validate_model);
    function("swmm_finalize_model",          &js_swmm_finalize_model);
    function("swmm_model_write",             &js_swmm_model_write);
    function("swmm_model_write_with_plugin", &js_swmm_model_write_with_plugin);

    // -----------------------------------------------------------------------
    // Model builder — add / pop
    // -----------------------------------------------------------------------
    function("swmm_node_add",      &js_swmm_node_add);
    function("swmm_node_pop_last", &js_swmm_node_pop_last);

    function("swmm_link_add",      &js_swmm_link_add);
    function("swmm_link_pop_last", &js_swmm_link_pop_last);

    function("swmm_subcatch_add",  &js_swmm_subcatch_add);
    function("swmm_gage_add",      &js_swmm_gage_add);

    // -----------------------------------------------------------------------
    // Model builder — link geometry setters
    // -----------------------------------------------------------------------
    function("swmm_link_set_nodes",     &js_swmm_link_set_nodes);
    function("swmm_link_set_length",    &js_swmm_link_set_length);
    function("swmm_link_set_roughness", &js_swmm_link_set_roughness);
    function("swmm_link_set_xsect",     &js_swmm_link_set_xsect);

    // -----------------------------------------------------------------------
    // Model builder — [TITLE]
    // -----------------------------------------------------------------------
    function("swmm_title_get_count", &js_swmm_title_get_count, allow_raw_pointers());
    function("swmm_title_get_line",  &js_swmm_title_get_line);
    function("swmm_title_add_line",  &js_swmm_title_add_line);
    function("swmm_title_set",       &js_swmm_title_set);
    function("swmm_title_clear",     &js_swmm_title_clear);

    // -----------------------------------------------------------------------
    // Model builder — [OPTIONS] / CRS
    // -----------------------------------------------------------------------
    function("swmm_options_get",     &js_swmm_options_get);
    function("swmm_options_set",     &js_swmm_options_set);
    function("swmm_options_get_ext", &js_swmm_options_get_ext);
    function("swmm_options_set_ext", &js_swmm_options_set_ext);
    function("swmm_get_crs",         &js_swmm_get_crs);

    // -----------------------------------------------------------------------
    // Model builder — typed date/time options
    // -----------------------------------------------------------------------
    function("swmm_options_get_start_date",   &js_swmm_options_get_start_date,   allow_raw_pointers());
    function("swmm_options_set_start_date",   &js_swmm_options_set_start_date);
    function("swmm_options_get_end_date",     &js_swmm_options_get_end_date,     allow_raw_pointers());
    function("swmm_options_set_end_date",     &js_swmm_options_set_end_date);
    function("swmm_options_get_report_start", &js_swmm_options_get_report_start, allow_raw_pointers());
    function("swmm_options_set_report_start", &js_swmm_options_set_report_start);

    // -----------------------------------------------------------------------
    // Model builder — user flags (schema-level)
    // -----------------------------------------------------------------------
    function("swmm_userflag_get_bool",  &js_swmm_userflag_get_bool,  allow_raw_pointers());
    function("swmm_userflag_get_int",   &js_swmm_userflag_get_int,   allow_raw_pointers());
    function("swmm_userflag_get_real",  &js_swmm_userflag_get_real,  allow_raw_pointers());
    function("swmm_userflag_set_bool",  &js_swmm_userflag_set_bool);
    function("swmm_userflag_set_int",   &js_swmm_userflag_set_int);
    function("swmm_userflag_set_real",  &js_swmm_userflag_set_real);
    function("swmm_userflag_def_count", &js_swmm_userflag_def_count, allow_raw_pointers());
    function("swmm_userflag_def_get",   &js_swmm_userflag_def_get);
    function("swmm_userflag_define",    &js_swmm_userflag_define);
    function("swmm_userflag_undefine",  &js_swmm_userflag_undefine);

    // -----------------------------------------------------------------------
    // Model builder — user flag per-object values
    // -----------------------------------------------------------------------
    function("swmm_userflag_value_get",   &js_swmm_userflag_value_get);
    function("swmm_userflag_value_set",   &js_swmm_userflag_value_set);
    function("swmm_userflag_value_clear", &js_swmm_userflag_value_clear);

    // -----------------------------------------------------------------------
    // Model builder — [PLUGINS]
    // -----------------------------------------------------------------------
    function("swmm_plugins_count",  &js_swmm_plugins_count, allow_raw_pointers());
    function("swmm_plugin_get",     &js_swmm_plugin_get);
    function("swmm_plugin_set",     &js_swmm_plugin_set);
    function("swmm_plugin_remove",  &js_swmm_plugin_remove);

    // -----------------------------------------------------------------------
    // Model builder — [FILES]
    // -----------------------------------------------------------------------
    function("swmm_files_get", &js_swmm_files_get);
    function("swmm_files_set", &js_swmm_files_set);

    // -----------------------------------------------------------------------
    // Model builder — external file path slots (IO-9)
    // -----------------------------------------------------------------------
    function("swmm_file_path_get", &js_swmm_file_path_get);
    function("swmm_file_path_set", &js_swmm_file_path_set);
}
