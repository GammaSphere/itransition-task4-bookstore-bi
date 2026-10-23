// Data explorer: SQL-backed tables with search, sorting, paging and filter chips.
// Filters are SQLite expressions so the assistant can drive them precisely.

import { countMatches, query, scalar } from "./db.js";
import { escapeHtml, int, money } from "./format.js";

const PAGE_SIZE = 20;

export const TABLES = {
  books: {
    label: "Books", noun: "books", key: "book_id",
    columns: [
      { key: "book_id", label: "ID", type: "id" },
      { key: "title", label: "Title", type: "text", search: true },
      { key: "author", label: "Author(s)", type: "text", search: true },
      { key: "genre", label: "Genre", type: "text", search: true },
      { key: "publisher", label: "Publisher", type: "text", search: true },
      { key: "year", label: "Year", type: "id" },
      { key: "books_sold", label: "Sold", type: "num" },
      { key: "revenue", label: "Revenue", type: "money" },
    ],
    sort: { column: "books_sold", direction: "desc" },
  },
  users: {
    label: "Users", noun: "user records", key: "user_id",
    columns: [
      { key: "user_id", label: "User ID", type: "id" },
      { key: "real_user_id", label: "Person", type: "id" },
      { key: "name", label: "Name", type: "text", search: true },
      { key: "email", label: "E-mail", type: "text", search: true },
      { key: "phone", label: "Phone", type: "text", search: true },
      { key: "address", label: "Address", type: "text", search: true },
      { key: "n_orders", label: "Orders", type: "num" },
      { key: "total_spent", label: "Spent", type: "money" },
    ],
    sort: { column: "user_id", direction: "asc" },
  },
  customers: {
    label: "Customers", noun: "real customers", key: "real_user_id",
    columns: [
      { key: "real_user_id", label: "Person", type: "id" },
      { key: "user_ids", label: "User IDs", type: "ids", search: true },
      { key: "n_records", label: "Records", type: "num" },
      { key: "name", label: "Name", type: "text", search: true },
      { key: "n_orders", label: "Orders", type: "num" },
      { key: "items", label: "Books", type: "num" },
      { key: "total_spent", label: "Spent", type: "money" },
    ],
    sort: { column: "total_spent", direction: "desc" },
  },
  orders: {
    label: "Orders", noun: "orders", key: "order_id",
    columns: [
      { key: "order_id", label: "Order", type: "id" },
      { key: "ts", label: "Timestamp", type: "text" },
      { key: "name", label: "Buyer", type: "text", search: true },
      { key: "user_id", label: "User ID", type: "id" },
      { key: "title", label: "Book", type: "text", search: true },
      { key: "quantity", label: "Qty", type: "num" },
      { key: "unit_price", label: "Unit price", type: "price" },
      { key: "paid_price", label: "Paid (USD)", type: "money" },
    ],
    sort: { column: "ts", direction: "desc" },
  },
};

const MODE_TEXT = { show: "Showing only", hide: "Hiding", highlight: "Highlighting" };
const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

function freshState(table) {
  return { filters: [], sort: { ...TABLES[table].sort }, page: 0, search: "", matchesOnly: false };
}

export class Explorer {
  constructor(root, { onChange } = {}) {
    this.root = root;
    this.onChange = onChange;
    this.store = null;
    this.db = null;
    this.table = "books";
    this.states = new Map(); // `${store}:${table}` -> state
    this.columnCache = new Map();
    this.nextId = 1;
    this.root.addEventListener("click", (e) => this.handleClick(e));
    this.root.addEventListener("input", (e) => {
      if (e.target.matches("[data-search]")) {
        clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(() => {
          const st = this.state();
          st.search = e.target.value;
          st.page = 0;
          this.renderBody();
        }, 200);
      }
    });
    this.root.addEventListener("change", (e) => {
      if (e.target.matches("[data-matches-only]")) {
        this.state().matchesOnly = e.target.checked;
        this.state().page = 0;
        this.renderBody();
      }
    });
  }

  state(table = this.table, store = this.store) {
    const key = `${store}:${table}`;
    if (!this.states.has(key)) this.states.set(key, freshState(table));
    return this.states.get(key);
  }

  setStore(store, db) {
    this.store = store;
    this.db = db;
    this.render();
  }

  columnsOf(table) {
    if (!this.db) return [];
    const key = `${this.store}:${table}`;
    if (!this.columnCache.has(key)) {
      this.columnCache.set(key, query(this.db, `SELECT * FROM ex_${table} LIMIT 0`).columns);
    }
    return this.columnCache.get(key);
  }

  // ------------------------------------------------------------- public API (UI + assistant)

  show(table) {
    if (!TABLES[table]) throw new Error(`Unknown table ${table}`);
    this.table = table;
    this.render();
    this.root.scrollIntoView({ behavior: "smooth", block: "start" });
    return { table, ...this.summary(table) };
  }

  addFilter({ table, mode, where, column, values, label, append }) {
    if (!this.db) throw new Error("Data is still loading, try again in a moment.");
    if (!TABLES[table]) throw new Error(`Unknown table ${table}`);
    if (!MODE_TEXT[mode]) throw new Error(`Unknown mode ${mode}`);
    let expr, params = [];
    if (Array.isArray(values) && values.length) {
      if (!column) throw new Error("`column` is required with `values`.");
      if (!this.columnsOf(table).includes(column)) {
        throw new Error(`Unknown column ${column}. Columns: ${this.columnsOf(table).join(", ")}`);
      }
      expr = `${quoteIdent(column)} IN (${values.map(() => "?").join(", ")})`;
      params = values.map(String);
    } else if (where && String(where).trim()) {
      expr = String(where).trim();
    } else {
      throw new Error("Give either `where` or `column` + `values`.");
    }
    let matched;
    try {
      matched = countMatches(this.db, table, expr, params);
    } catch (e) {
      throw new Error(`Invalid filter: ${e.message}. Columns: ${this.columnsOf(table).join(", ")}`);
    }
    const st = this.state(table);
    const filter = { id: this.nextId++, mode, expr, params, label: label || expr, matched, ai: true };
    st.filters = append ? [...st.filters, filter] : [filter];
    st.page = 0;
    st.matchesOnly = false;
    this.table = table;
    this.render();
    this.root.scrollIntoView({ behavior: "smooth", block: "start" });
    const total = scalar(this.db, `SELECT COUNT(*) FROM ex_${table}`);
    return {
      table, mode, label: filter.label, matched_rows: matched, total_rows: total,
      ...this.summary(table),
      sample: this.sampleMatches(table, expr, params),
    };
  }

  clearFilters(table) {
    const tables = table ? [table] : Object.keys(TABLES);
    for (const t of tables) {
      const st = this.state(t);
      st.filters = [];
      st.page = 0;
      st.matchesOnly = false;
    }
    this.render();
    return { cleared: tables };
  }

  sortBy({ table, column, direction }) {
    if (!TABLES[table]) throw new Error(`Unknown table ${table}`);
    if (!this.columnsOf(table).includes(column)) {
      throw new Error(`Unknown column ${column}. Columns: ${this.columnsOf(table).join(", ")}`);
    }
    const st = this.state(table);
    st.sort = { column, direction: direction === "asc" ? "asc" : "desc" };
    st.page = 0;
    this.table = table;
    this.render();
    this.root.scrollIntoView({ behavior: "smooth", block: "start" });
    return { table, sorted_by: column, direction: st.sort.direction, first_rows: this.pageRows(table).rows.slice(0, 5) };
  }

  describe() {
    return {
      open_table: this.table,
      filters: Object.keys(TABLES).flatMap((t) => this.state(t).filters.map((f) => ({
        table: t, mode: f.mode, label: f.label, matched: f.matched,
      }))),
      sort: this.state().sort,
    };
  }

  // ------------------------------------------------------------------------ query building

  buildWhere(table) {
    const st = this.state(table);
    const clauses = [], params = [];
    for (const f of st.filters) {
      if (f.mode === "show") clauses.push(`COALESCE((${f.expr}), 0)`);
      else if (f.mode === "hide") clauses.push(`NOT COALESCE((${f.expr}), 0)`);
      else continue;
      params.push(...f.params);
    }
    const hl = this.highlightExpr(table);
    if (st.matchesOnly && hl.expr) {
      clauses.push(hl.expr);
      params.push(...hl.params);
    }
    const term = st.search.trim();
    if (term) {
      const cols = TABLES[table].columns.filter((c) => c.search).map((c) => quoteIdent(c.key));
      clauses.push(`(${cols.map((c) => `CAST(${c} AS TEXT) LIKE ?`).join(" OR ")})`);
      params.push(...cols.map(() => `%${term}%`));
    }
    return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  highlightExpr(table) {
    const hs = this.state(table).filters.filter((f) => f.mode === "highlight");
    if (!hs.length) return { expr: null, params: [] };
    return {
      expr: `(${hs.map((f) => `COALESCE((${f.expr}), 0)`).join(" AND ")})`,
      params: hs.flatMap((f) => f.params),
    };
  }

  summary(table) {
    const where = this.buildWhere(table);
    const hl = this.highlightExpr(table);
    const sql = `SELECT COUNT(*), ${hl.expr ? `SUM(CASE WHEN ${hl.expr} THEN 1 ELSE 0 END)` : "NULL"} FROM ex_${table} ${where.sql}`;
    const [[visible, highlighted]] = query(this.db, sql, [...hl.params, ...where.params]).rows;
    return { visible_rows: visible, highlighted_rows: highlighted };
  }

  pageRows(table, { all = false } = {}) {
    const st = this.state(table);
    const where = this.buildWhere(table);
    const hl = this.highlightExpr(table);
    const cols = this.columnsOf(table);
    const sortCol = cols.includes(st.sort.column) ? st.sort.column : TABLES[table].sort.column;
    const dir = st.sort.direction === "asc" ? "ASC" : "DESC";
    const limit = all ? "" : `LIMIT ${PAGE_SIZE} OFFSET ${st.page * PAGE_SIZE}`;
    const sql = `SELECT *, ${hl.expr ? `CASE WHEN ${hl.expr} THEN 1 ELSE 0 END` : "0"} AS __hl
      FROM ex_${table} ${where.sql}
      ORDER BY ${quoteIdent(sortCol)} IS NULL, ${quoteIdent(sortCol)} ${dir}, ${quoteIdent(TABLES[table].key)} ${limit}`;
    return query(this.db, sql, [...hl.params, ...where.params]);
  }

  sampleMatches(table, expr, params) {
    const keyCols = TABLES[table].columns.slice(0, 4).map((c) => quoteIdent(c.key)).join(", ");
    return query(this.db, `SELECT ${keyCols} FROM ex_${table} WHERE COALESCE((${expr}), 0) LIMIT 5`, params).rows;
  }

  // ------------------------------------------------------------------------------ rendering

  render() {
    const tabs = Object.entries(TABLES).map(([key, t]) => `
      <li class="nav-item"><a href="#" class="nav-link ${key === this.table ? "active" : ""}" data-table="${key}">
        ${t.label}${this.state(key).filters.length ? ' <span class="badge bg-blue-lt ms-1">filtered</span>' : ""}
      </a></li>`).join("");
    this.root.innerHTML = `
      <div class="card-header border-bottom-0 pb-0">
        <ul class="nav nav-tabs card-header-tabs">${tabs}</ul>
      </div>
      <div class="card-body border-bottom py-3" data-toolbar></div>
      <div class="table-responsive" data-table-wrap></div>
      <div class="card-footer d-flex align-items-center flex-wrap gap-2" data-footer></div>`;
    this.renderBody();
  }

  renderBody() {
    const toolbar = this.root.querySelector("[data-toolbar]");
    const wrap = this.root.querySelector("[data-table-wrap]");
    const footer = this.root.querySelector("[data-footer]");
    if (!toolbar) return;
    if (!this.db) {
      wrap.innerHTML = '<div class="p-4 text-secondary"><span class="spinner-border spinner-border-sm me-2"></span>Loading store database…</div>';
      toolbar.innerHTML = footer.innerHTML = "";
      return;
    }
    const table = this.table;
    const meta = TABLES[table];
    const st = this.state(table);
    const total = scalar(this.db, `SELECT COUNT(*) FROM ex_${table}`);
    const { visible_rows: visible, highlighted_rows: highlighted } = this.summary(table);
    const maxPage = Math.max(0, Math.ceil(visible / PAGE_SIZE) - 1);
    if (st.page > maxPage) st.page = maxPage;
    const { columns, rows } = this.pageRows(table);
    const hasHighlight = st.filters.some((f) => f.mode === "highlight");

    const chips = st.filters.map((f) => `
      <span class="filter-chip filter-chip-${f.mode}">
        ${f.ai ? '<i class="ti ti-sparkles" aria-label="Applied by assistant"></i>' : ""}
        <span class="filter-chip-mode">${MODE_TEXT[f.mode]}</span>
        <span class="filter-chip-label" title="${escapeHtml(f.expr)}">${escapeHtml(f.label)}</span>
        <span class="filter-chip-count">${int(f.matched)} match</span>
        ${f.mode !== "highlight" ? `<button class="btn btn-ghost-secondary btn-sm btn-icon" data-invert="${f.id}" title="Invert (show ⇄ hide)" aria-label="Invert filter"><i class="ti ti-arrows-exchange"></i></button>` : ""}
        <button class="btn btn-ghost-secondary btn-sm btn-icon" data-remove="${f.id}" title="Remove filter" aria-label="Remove filter"><i class="ti ti-x"></i></button>
      </span>`).join("");

    toolbar.innerHTML = `
      <div class="d-flex flex-wrap align-items-center gap-2">
        <div class="input-icon explorer-search">
          <span class="input-icon-addon"><i class="ti ti-search"></i></span>
          <input type="search" class="form-control form-control-sm" placeholder="Search ${meta.noun}…" value="${escapeHtml(st.search)}" data-search aria-label="Search ${meta.noun}">
        </div>
        ${chips}
        ${hasHighlight ? `<label class="form-check form-switch m-0 ms-1"><input class="form-check-input" type="checkbox" data-matches-only ${st.matchesOnly ? "checked" : ""}><span class="form-check-label small">Highlighted only</span></label>` : ""}
        ${st.filters.length ? '<button class="btn btn-sm btn-link px-1" data-clear>Clear filters</button>' : ""}
        <div class="ms-auto d-flex align-items-center gap-2">
          <span class="text-secondary small">${int(visible)} of ${int(total)} ${meta.noun}${hasHighlight ? ` · <strong>${int(highlighted || 0)}</strong> highlighted` : ""}</span>
          <button class="btn btn-sm btn-outline-secondary" data-csv title="Download the filtered rows as CSV"><i class="ti ti-download me-1"></i>CSV</button>
        </div>
      </div>`;

    const idx = Object.fromEntries(columns.map((c, i) => [c, i]));
    const head = meta.columns.map((c) => {
      const active = st.sort.column === c.key;
      const arrow = active ? (st.sort.direction === "asc" ? "ti-arrow-up" : "ti-arrow-down") : "ti-arrows-sort";
      return `<th class="${["num", "money", "price"].includes(c.type) ? "text-end" : ""}">
        <button class="table-sort-btn ${active ? "active" : ""}" data-sort="${c.key}">${c.label}<i class="ti ${arrow}"></i></button></th>`;
    }).join("");
    const body = rows.length ? rows.map((r) => `
      <tr class="${r[idx.__hl] ? "row-highlight" : ""}">
        ${meta.columns.map((c) => this.cell(c, r, idx)).join("")}
      </tr>`).join("") : `<tr><td colspan="${meta.columns.length}" class="text-center text-secondary py-4">No ${meta.noun} match.</td></tr>`;
    wrap.innerHTML = `<table class="table table-vcenter card-table table-sm explorer-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;

    footer.innerHTML = `
      <span class="text-secondary small">Page ${int(st.page + 1)} of ${int(maxPage + 1)}</span>
      <ul class="pagination m-0 ms-auto">
        <li class="page-item ${st.page === 0 ? "disabled" : ""}"><a class="page-link" href="#" data-page="0" aria-label="First page"><i class="ti ti-chevrons-left"></i></a></li>
        <li class="page-item ${st.page === 0 ? "disabled" : ""}"><a class="page-link" href="#" data-page="${st.page - 1}" aria-label="Previous page"><i class="ti ti-chevron-left"></i></a></li>
        <li class="page-item ${st.page >= maxPage ? "disabled" : ""}"><a class="page-link" href="#" data-page="${st.page + 1}" aria-label="Next page"><i class="ti ti-chevron-right"></i></a></li>
        <li class="page-item ${st.page >= maxPage ? "disabled" : ""}"><a class="page-link" href="#" data-page="${maxPage}" aria-label="Last page"><i class="ti ti-chevrons-right"></i></a></li>
      </ul>`;
    this.onChange?.(this.describe());
  }

  cell(col, row, idx) {
    const v = row[idx[col.key]];
    if (v == null) return '<td class="text-secondary">—</td>';
    switch (col.type) {
      case "money": return `<td class="text-end tabular">${money(v)}</td>`;
      case "num": return `<td class="text-end tabular">${int(v)}</td>`;
      case "id": return `<td class="tabular text-secondary">${escapeHtml(v)}</td>`;
      case "ids": return `<td class="tabular">${escapeHtml(String(v).replace(/,/g, ", "))}</td>`;
      case "price": {
        const cur = row[idx.currency];
        return `<td class="text-end tabular">${cur === "EUR" ? "€" : "$"}${Number(v).toFixed(2)}</td>`;
      }
      default: return `<td class="cell-text" title="${escapeHtml(v)}">${escapeHtml(v)}</td>`;
    }
  }

  handleClick(e) {
    const t = e.target.closest("[data-table],[data-sort],[data-page],[data-remove],[data-invert],[data-clear],[data-csv]");
    if (!t) return;
    e.preventDefault();
    const st = this.state();
    if (t.dataset.table) {
      this.table = t.dataset.table;
      this.render();
    } else if (t.dataset.sort) {
      const col = t.dataset.sort;
      st.sort = { column: col, direction: st.sort.column === col && st.sort.direction === "desc" ? "asc" : "desc" };
      st.page = 0;
      this.renderBody();
    } else if (t.dataset.page !== undefined) {
      if (t.closest(".disabled")) return;
      st.page = Math.max(0, parseInt(t.dataset.page, 10));
      this.renderBody();
    } else if (t.dataset.remove) {
      st.filters = st.filters.filter((f) => f.id !== Number(t.dataset.remove));
      this.render();
    } else if (t.dataset.invert) {
      const f = st.filters.find((x) => x.id === Number(t.dataset.invert));
      if (f) f.mode = f.mode === "show" ? "hide" : "show";
      this.renderBody();
    } else if (t.hasAttribute("data-clear")) {
      this.clearFilters(this.table);
    } else if (t.hasAttribute("data-csv")) {
      this.downloadCsv();
    }
  }

  downloadCsv() {
    const { columns, rows } = this.pageRows(this.table, { all: true });
    const keep = columns.map((c, i) => [c, i]).filter(([c]) => c !== "__hl");
    const esc = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const csv = [keep.map(([c]) => c).join(","), ...rows.map((r) => keep.map(([, i]) => esc(r[i])).join(","))].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `${this.store}_${this.table}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
