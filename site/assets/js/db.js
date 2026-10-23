// SQLite (sql.js) access to the per-store databases produced by the pandas pipeline.

export const STORES = ["STORE1", "STORE2", "STORE3", "STORE4", "STORE5"];

const SQLJS_WASM = "https://cdn.jsdelivr.net/npm/sql.js@1.12.0/dist/sql-wasm.wasm";
let sqlPromise = null;
const dbPromises = new Map();

// Explorer tables are materialized once per database so paging/sorting stays instant.
// Computed columns are CAST so they get a numeric affinity: without it, a filter value bound
// as text ('2') would never equal the number 2.
export const EXPLORER_SOURCES = {
  books: `
    SELECT b.book_id, b.title, b.author, b.genre, b.publisher, b.year, b.n_authors, b.author_set,
           CAST(COALESCE(s.sold, 0) AS INTEGER) AS books_sold, CAST(ROUND(COALESCE(s.rev, 0), 2) AS REAL) AS revenue
    FROM books b
    LEFT JOIN (SELECT book_id, SUM(quantity) AS sold, SUM(paid_price) AS rev FROM orders GROUP BY book_id) s
      USING (book_id)`,
  users: `
    SELECT u.user_id, u.real_user_id, u.name, u.email, u.phone, u.address,
           CAST(COALESCE(s.n, 0) AS INTEGER) AS n_orders, CAST(ROUND(COALESCE(s.spent, 0), 2) AS REAL) AS total_spent
    FROM users u
    LEFT JOIN (SELECT user_id, COUNT(*) AS n, SUM(paid_price) AS spent FROM orders GROUP BY user_id) s
      USING (user_id)`,
  customers: `
    SELECT CAST(real_user_id AS INTEGER) AS real_user_id, user_ids, CAST(n_records AS INTEGER) AS n_records, name,
           CAST(total_spent AS REAL) AS total_spent, CAST(n_orders AS INTEGER) AS n_orders, CAST(items AS INTEGER) AS items
    FROM customers`,
  orders: `
    SELECT o.order_id, o.date, o.ts, o.user_id, o.real_user_id, u.name, o.book_id, b.title,
           o.quantity, o.unit_price, o.currency, o.paid_price, o.shipping
    FROM orders o
    LEFT JOIN users u USING (user_id)
    LEFT JOIN books b USING (book_id)`,
};

function loadSql() {
  if (!sqlPromise) {
    // initSqlJs is the global defined by sql-wasm.js
    sqlPromise = window.initSqlJs({ locateFile: () => SQLJS_WASM });
  }
  return sqlPromise;
}

export function openStore(store) {
  if (!STORES.includes(store)) return Promise.reject(new Error(`Unknown store ${store}`));
  if (!dbPromises.has(store)) {
    const p = (async () => {
      const [SQL, buf] = await Promise.all([
        loadSql(),
        fetch(`data/${store}.sqlite.gz`).then(async (r) => {
          if (!r.ok) throw new Error(`Could not load ${store} database (${r.status})`);
          const bytes = await r.arrayBuffer();
          const head = new Uint8Array(bytes, 0, 2);
          // A CDN may already have decoded it (Content-Encoding: gzip); only gunzip real gzip data.
          if (head[0] !== 0x1f || head[1] !== 0x8b) return bytes;
          return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
        }),
      ]);
      const db = new SQL.Database(new Uint8Array(buf));
      for (const [name, sql] of Object.entries(EXPLORER_SOURCES)) {
        db.run(`CREATE TEMP TABLE ex_${name} AS ${sql}`);
      }
      return db;
    })();
    p.catch(() => dbPromises.delete(store));
    dbPromises.set(store, p);
  }
  return dbPromises.get(store);
}

/** Run a query and return { columns, rows } with rows as arrays. */
export function query(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const columns = stmt.getColumnNames();
    const rows = [];
    while (stmt.step()) rows.push(stmt.get());
    return { columns, rows };
  } finally {
    stmt.free();
  }
}

export function scalar(db, sql, params = []) {
  const { rows } = query(db, sql, params);
  return rows.length ? rows[0][0] : null;
}

// REPLACE(...) is a legitimate string function, so only the REPLACE INTO statement is blocked.
const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release)\b|\breplace\s+into\b/i;

/** Reject anything that is not a single read-only SELECT. String literals are ignored when scanning. */
export function assertReadOnly(sql) {
  const text = String(sql || "").trim().replace(/;\s*$/, "");
  const bare = text.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
  if (!/^(select|with)\b/i.test(bare)) throw new Error("Only SELECT queries are allowed.");
  if (bare.includes(";")) throw new Error("Only a single statement is allowed.");
  if (FORBIDDEN.test(bare)) throw new Error("Only read-only queries are allowed.");
  return text;
}

/** Validate a boolean filter expression against an explorer table; returns the number of matching rows. */
export function countMatches(db, table, expr, params = []) {
  if (/;/.test(expr.replace(/'(?:[^']|'')*'/g, ""))) throw new Error("A filter must be a single expression.");
  if (FORBIDDEN.test(expr.replace(/'(?:[^']|'')*'/g, ""))) throw new Error("Only read-only expressions are allowed.");
  return scalar(db, `SELECT COUNT(*) FROM ex_${table} WHERE COALESCE((${expr}), 0)`, params);
}
