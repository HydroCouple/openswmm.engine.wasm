/**
 * Real module: the report summary tables (`swmm_summary_*`, added with the
 * 2026-11-17 engine pin) read back after a full run of tests/fixtures/smoke.inp.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { built, fixtures, load, title, work } from "./load.js";

describe.skipIf(!built)(title("real module: summary tables"), () => {
  it("Node Depth Summary has one row per node after the run ends", async () => {
    const { mod, pkg, raw, mem } = await load();
    const api = raw.bindRaw(mod);
    const solver = new pkg.Solver(mod);
    try {
      solver.writeFile("/smoke.inp", readFileSync(resolve(fixtures, "smoke.inp"), "utf8"));
      solver.open("/smoke.inp", "/smoke.rpt", "/smoke.out");
      solver.initialize();
      solver.start(true);
      while (solver.step() > 0);
      solver.end();

      const table = pkg.SummaryTable.NODE_DEPTH;
      const rows = mem.withInt(mod, (p) => api.swmm_summary_row_count(solver.handle, table, p));
      const columns = mem.withInt(mod, (p) =>
        api.swmm_summary_column_count(solver.handle, table, p),
      );
      const buf = mem.checkedAlloc(mod, 128);
      let heading: string;
      try {
        pkg.raiseForCode(api.swmm_summary_table_title(solver.handle, table, buf, 128));
        heading = mod.UTF8ToString(buf);
      } finally {
        mod._free(buf);
      }
      const nodes = solver.nodes.length;
      solver.close();
      writeFileSync(
        resolve(work, "summary_tables.json"),
        JSON.stringify({ heading, rows, columns, nodes }, null, 1) + "\n",
      );

      expect(heading).toBe("Node Depth Summary");
      expect(nodes).toBeGreaterThan(0);
      expect(rows).toBe(nodes);
      expect(columns).toBeGreaterThan(0);
    } finally {
      solver.destroy();
    }
  });
});
