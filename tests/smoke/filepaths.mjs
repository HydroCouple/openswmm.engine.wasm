// SPDX-License-Identifier: Apache-2.0
// Run against the compiled module: node tests/smoke/filepaths.mjs
// Some Node versions require --experimental-wasm-eh. Reviewable inputs and
// saved models are retained under tests/_work/filepaths/ after each case.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
function fail(err) {
  console.error(`filepaths: FAIL — ${err.message ?? err}`);
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { default: createModule } = await import(path.join(root, 'dist/openswmm_engine.js'));
const mod = await createModule();
const wrap = (name, args, result = 'number') => mod.cwrap(name, result, args);
const create = wrap('swmm_engine_create', []);
const destroy = wrap('swmm_engine_destroy', ['number']);
const open = wrap('swmm_engine_open', ['number', 'string', 'string', 'string', 'string']);
const write = wrap('swmm_model_write', ['number', 'string']);
const error = wrap('swmm_get_last_error_msg', ['number'], 'string');
const getPath = wrap('swmm_file_path_get', ['number', 'number', 'string', 'number', 'number', 'number', 'number']);
const pluginSet = wrap('swmm_plugin_set', ['number', 'string', 'string']);
const pluginGet = wrap('swmm_plugin_get', Array(6).fill('number'));
const componentGet = wrap('swmm_process_component_get', Array(8).fill('number'));
const has2D = typeof mod._swmm_2d_is_active === 'function';
const base = `[OPTIONS]
FLOW_UNITS CMS
FLOW_ROUTING DYNWAVE
START_DATE 01/01/2020
END_DATE 01/01/2020
END_TIME 01:00:00
REPORT_STEP 00:05:00
ROUTING_STEP 5
[JUNCTIONS]
J1 10 5 0 0 0
[OUTFALLS]
O1 0 FREE NO
[CONDUITS]
C1 J1 O1 400 0.01 0 0 0 0
[XSECTIONS]
C1 CIRCULAR 1 0 0 0 1
[POLLUTANTS]
TSS MG/L 0 0 0 0 NO * 0 0 0
`;
const mesh = '[2D_VERTICES]\n0 0 0\n10 0 0\n0 10 0\n[2D_TRIANGLES]\n0 1 2 0.035 0\n';
const pluginArgs = 'file="Results  Folder/plugin output.h5" compress=9 "bare  argument; v1"';
const buffers = (count, action) => {
  const ptrs = Array.from({ length: count }, () => mod._malloc(4096));
  try { return action(ptrs); }
  finally { ptrs.forEach(p => mod._free(p)); }
};
function original(engine, role) {
  return buffers(2, ([a, o]) => {
    assert.equal(getPath(engine, role, null, a, 4096, o, 4096), 0);
    return mod.UTF8ToString(o);
  });
}

let passed = 0;
for (const kind of ['mesh', 'output', 'quality', 'groundwater', 'component', 'plugin', 'unquoted-mesh', 'csv-mesh']) {
  if (!has2D && ['mesh', 'output', 'groundwater', 'unquoted-mesh', 'csv-mesh'].includes(kind)) continue;
  for (const [i, name] of ['My Model', 'My  Model', 'My; Model'].entries()) {
    if (['unquoted-mesh', 'csv-mesh'].includes(kind) && i !== 1) continue;
    const virtual = `/filepaths/${kind}-${i}`;
    const local = path.join(root, 'tests/_work/filepaths', `${kind}-${i}`);
    fs.mkdirSync(local, { recursive: true });
    const put = (filename, text) => {
      mod.FS.mkdirTree(path.posix.dirname(`${virtual}/${filename}`));
      mod.FS.writeFile(`${virtual}/${filename}`, text);
      fs.mkdirSync(path.dirname(path.join(local, filename)), { recursive: true });
      fs.writeFileSync(path.join(local, filename), text);
    };
    let extra = '', reference = '';
    if (['mesh', 'unquoted-mesh', 'csv-mesh'].includes(kind)) {
      reference = `Mesh  Folder/${name}.2dm`;
      put(reference, mesh);
      put('Mesh Folder/My Model.2dm', '[2D_VERTICES]\n0 0 99\n10 0 99\n0 10 99\n[2D_TRIANGLES]\n0 1 2 0.035 0\n');
      extra = `[2D_MESH_FILE]\n${kind === 'csv-mesh' ? 'FILE ,' : 'FILE'} ${kind === 'unquoted-mesh' ? reference : `"${reference}"`}\n`;
    } else if (kind === 'output') {
      reference = `Results  Folder/${name}.h5`;
      extra = `[2D_OPTIONS]\nREPORT_2D NO\nOUTPUT_FILE "${reference}"\n${mesh}`;
    } else if (kind === 'quality' || kind === 'groundwater') {
      reference = `Quality  Folder/${name}.csv`;
      put(reference, kind === 'quality' ? 'scope,element,constituent,value\nNODE,J1,TSS,2\n'
        : 'scope,zone,species,value\n*,SAT,TSS,2\n');
      extra = `${kind === 'groundwater' ? mesh : ''}[${kind === 'quality' ? 'INITIAL_QUALITY' : 'GW_INITIAL_QUALITY'}]\nFILE "${reference}"\n`;
    } else if (kind === 'component') {
      reference = `Config  Folder/${name}.rxn`;
      put(reference, '[REACTION_SPECIES]\nBULK A MG\n');
      extra = `[PROCESS_COMPONENTS]\norg.hydrocouple.openswmm.reactions config="${reference}"\n`;
    } else reference = `Plugin  Folder/${name}.dylib`;
    put('Source Model.inp', base + extra);
    const check = engine => {
      if (kind.includes('mesh')) assert.equal(original(engine, 11), reference);
      else if (kind === 'output') assert.equal(original(engine, 12), reference);
      else if (kind === 'groundwater') buffers(1, ([p]) => {
        assert.equal(mod._swmm_gw_init_quality_file_get(engine, p, 4096), 0);
        assert.equal(mod.UTF8ToString(p), reference);
      });
      else if (kind === 'component') buffers(3, ([id, cfg, resolved]) => {
        assert.equal(componentGet(engine, 0, id, 4096, cfg, 4096, resolved, 4096), 0);
        assert.equal(mod.UTF8ToString(cfg), reference);
      });
      else if (kind === 'plugin') buffers(2, ([p, args]) => {
        assert.equal(pluginGet(engine, 0, p, 4096, args, 4096), 0);
        assert.equal(mod.UTF8ToString(p), reference);
        assert.equal(mod.UTF8ToString(args), pluginArgs);
      });
    };
    const engine = create(), reopened = create();
    try {
      assert.equal(open(engine, `${virtual}/Source Model.inp`, `${virtual}/Source Report.rpt`, null, null), 0, error(engine));
      if (kind === 'plugin') assert.equal(pluginSet(engine, reference, pluginArgs), 0);
      check(engine);
      assert.equal(write(engine, `${virtual}/Saved Model.inp`), 0, error(engine));
      const saved = mod.FS.readFile(`${virtual}/Saved Model.inp`, { encoding: 'utf8' });
      fs.writeFileSync(path.join(local, 'Saved Model.inp'), saved);
      assert.equal(open(reopened, `${virtual}/Saved Model.inp`, `${virtual}/Saved Report.rpt`, null, null), 0, error(reopened));
      check(reopened);
      // No truncated quality path exists, so successful reopen reads the CSV.
      if (kind === 'quality') assert(saved.includes(`"${reference}"`));
      ++passed;
    } finally { destroy(reopened); destroy(engine); }
  }
}
console.log(`filepaths: ${passed} save/reopen cases passed${has2D ? '' : ' (2D cases skipped)'}`);
