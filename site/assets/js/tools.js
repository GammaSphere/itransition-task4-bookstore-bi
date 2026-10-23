// Tool implementations for the assistant. Data tools compute exact answers with SQL;
// UI tools delegate to the dashboard controller.

import { STORES, assertReadOnly, openStore, query } from "./db.js";

const DEFAULT_ROWS = 200;
const MAX_ROWS = 1000;

function tidy(value) {
  if (typeof value === "number" && !Number.isInteger(value)) return Math.round(value * 1e4) / 1e4;
  return value;
}

function headlineMetrics(m) {
  const { daily_revenue, ...rest } = m;
  return rest;
}

async function runSqlOn(store, sql, maxRows) {
  const db = await openStore(store);
  const { columns, rows } = query(db, sql);
  return {
    columns,
    rows: rows.slice(0, maxRows).map((r) => r.map(tidy)),
    row_count: rows.length,
    truncated: rows.length > maxRows,
  };
}

export function createToolRunner({ getMetrics, ui }) {
  const handlers = {
    async get_store_metrics({ store }) {
      const all = getMetrics();
      if (store === "ALL") {
        return Object.fromEntries(STORES.map((s) => [s, headlineMetrics(all[s])]));
      }
      if (!all[store]) throw new Error(`Unknown store ${store}`);
      return headlineMetrics(all[store]);
    },

    async run_sql({ store, sql, max_rows }) {
      const text = assertReadOnly(sql);
      const limit = Math.min(Math.max(parseInt(max_rows, 10) || DEFAULT_ROWS, 1), MAX_ROWS);
      if (store === "ALL") {
        const out = {};
        for (const s of STORES) {
          try {
            out[s] = await runSqlOn(s, text, limit);
          } catch (e) {
            out[s] = { error: e.message };
          }
        }
        return out;
      }
      if (!STORES.includes(store)) throw new Error(`Unknown store ${store}`);
      return runSqlOn(store, text, limit);
    },

    switch_store: (args) => ui.switchStore(args.store),
    filter_table: (args) => ui.filterTable(args),
    clear_filters: (args) => ui.clearFilters(args.table),
    sort_table: (args) => ui.sortTable(args),
    show_table: (args) => ui.showTable(args.table),
    set_chart: (args) => ui.setChart(args),
    set_theme: (args) => ui.setTheme(args.theme),
  };

  return {
    names: Object.keys(handlers),
    async execute(name, args = {}) {
      const handler = handlers[name];
      if (!handler) return { error: `Unknown tool ${name}` };
      try {
        return await handler(args || {});
      } catch (e) {
        return { error: e.message || String(e) };
      }
    },
  };
}
