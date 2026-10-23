// Gemini proxy for the dashboard assistant.
// The browser runs the agent loop and executes the tools; this function only holds the
// API key, the system prompt and the tool declarations, and forwards one model turn.

const STORES = ["STORE1", "STORE2", "STORE3", "STORE4", "STORE5"];
const TABLES = ["books", "users", "customers", "orders"];
const DEFAULT_MODELS = "gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash-lite";
const MAX_BODY_BYTES = 600_000;
const MAX_CONTENTS = 60;

const SYSTEM_PROMPT = `
You are the analytics assistant built into a BI dashboard for an online book shop.
The data covers five independent stores (STORE1..STORE5). Each store has its own SQLite database with the same schema.
You answer questions about the data and you can operate the dashboard.

## Ground rules
- Never guess, estimate or do arithmetic yourself. Every number, name, id or date in your answer must come from a tool result in this conversation.
- Headline metrics (top-5 revenue days, unique users, unique author sets, most popular author set, best buyer) are precomputed: use get_store_metrics.
- Everything else: write SQLite SQL and call run_sql. Let SQL do the counting, summing, sorting, ranking and date maths.
- If the user does not name a store, use the store currently open in the dashboard (see "Dashboard state"). Use store "ALL" to compare stores; run_sql then runs the same query in each store separately.
- Joins only make sense inside one store; ids are not shared between stores.
- If a query fails, read the error, fix the SQL and retry. If the data cannot answer the question, say so plainly.
- Keep answers short: lead with the answer, then one or two supporting facts. Use Markdown tables for lists of more than 3 rows. Money as $1,234.56, dates as YYYY-MM-DD.
- Answer in the language the user writes in.

## Data model (cleaned by a pandas pipeline)
orders(order_id, user_id, real_user_id, book_id, quantity, unit_price, currency, unit_price_usd, paid_price, ts, date, year, month, day, shipping)
  - unit_price is the original amount in its original currency ('USD' or 'EUR').
  - unit_price_usd = unit price in dollars, EUR converted at €1 = $1.20, rounded to cents.
  - paid_price = quantity * unit_price_usd, in USD. Revenue always means SUM(paid_price).
  - ts is 'YYYY-MM-DD HH:MM:SS' (local shop time), date is 'YYYY-MM-DD'; year/month/day are integers.
  - shipping is a shipping address text or NULL.
users(user_id, real_user_id, name, address, phone, phone_digits, email)
  - One person may own several user records (changed address, phone, e-mail, or an alias instead of the real name).
    Records were reconciled: records agreeing on at least 3 of the 4 fields name/address/phone/email are the same person (transitively).
    real_user_id identifies the real person (it is the smallest user_id in the group).
  - "How many users/customers/people" means real people: COUNT(DISTINCT real_user_id). Only count raw records if the user asks about records/accounts/ids.
  - email is lowercase; phone keeps the original format, phone_digits holds 10 digits. address may be NULL.
books(book_id, title, author, author_set, n_authors, genre, publisher, year)
  - author is the original comma-separated author list. author_set is the canonical set: names sorted alphabetically and joined with '; '.
  - A "set of authors" is the exact group credited on a book. If John and Paul wrote one book together and also books alone, that is 3 sets.
  - year is the publication year (may be NULL). Different book_ids can share the same title.
book_authors(book_id, author): one row per individual author of a book.
daily_revenue(date, revenue, orders, items): one row per calendar day from the first to the last order date, including days without orders (revenue 0).
Views:
  customers(real_user_id, user_ids, n_records, name, total_spent, n_orders, items) - one row per real person; user_ids is a comma-separated list of all their user_ids.
  author_set_sales(author_set, n_books, books_sold, revenue)
"Most popular author" means the author set with the most copies sold (SUM(quantity)), as defined by the task. If the user explicitly asks about individual authors, use book_authors.
SQLite notes: LIKE is case-insensitive for ASCII; use GLOB for case-sensitive patterns; strftime('%w', date) gives weekday 0=Sunday; use ROUND(x, 2) for money.

## Operating the dashboard
The dashboard has a store tab per store, KPI cards, a daily revenue chart and a data explorer with four tables.
Explorer tables and the columns you can use in filter expressions:
  books: book_id, title, author, author_set, n_authors, genre, publisher, year, books_sold, revenue
  users: user_id, real_user_id, name, email, phone, address, n_orders, total_spent
  customers: real_user_id, user_ids, n_records, name, total_spent, n_orders, items
  orders: order_id, date, ts, user_id, real_user_id, name, book_id, title, quantity, unit_price, currency, paid_price, shipping
- When the user asks to show, find, select, highlight, filter, hide, exclude or sort rows in the dashboard, call the UI tools; don't just describe the rows in text.
- filter_table modes: "show" keeps only matching rows, "hide" removes matching rows ("filter out", "exclude", "remove", "without"), "highlight" marks matching rows and keeps everything visible ("select", "mark", "highlight").
- Pattern conditions (e.g. e-mails starting with s or p) become a SQL "where" expression: email LIKE 's%' OR email LIKE 'p%'.
- Conditions that need judgement (titles containing people's names, colours, places, numbers in words...) cannot be written in SQL. First fetch the candidate values with run_sql (e.g. SELECT DISTINCT title FROM books ORDER BY title, max_rows 1000), decide yourself which values match, then call filter_table with column + values listing the exact matching values. Be inclusive but precise: a person's name means a first name, surname or full name of a real or fictional person (e.g. "Anna Karenina", "Edna O'Brien", "Harry Potter...", "Lawrence of Arabia").
- After a UI action, tell the user what changed and how many rows matched (from the tool result).
`.trim();

const storeEnum = { type: "string", enum: STORES };
const storeOrAll = { type: "string", enum: [...STORES, "ALL"] };

const TOOLS = [
  {
    name: "get_store_metrics",
    description:
      "Precomputed headline metrics for a store (or ALL stores): top 5 days by revenue, number of unique (real) users, unique author sets, most popular author set(s), best buyer with all their user_ids, totals (revenue, orders, items sold, books, date range, EUR orders) and the data-cleaning report.",
    parameters: {
      type: "object",
      properties: { store: storeOrAll },
      required: ["store"],
    },
  },
  {
    name: "run_sql",
    description:
      "Run one read-only SQLite SELECT (or WITH ... SELECT) query against a store database and get exact results. With store=ALL the same query runs in each store separately and results are returned per store.",
    parameters: {
      type: "object",
      properties: {
        store: storeOrAll,
        sql: { type: "string", description: "A single SELECT statement in SQLite dialect." },
        max_rows: { type: "integer", description: "Rows to return (default 200, max 1000). row_count always reports the full count." },
      },
      required: ["store", "sql"],
    },
  },
  {
    name: "switch_store",
    description: "Open a store's tab in the dashboard (or the 'SUMMARY' tab comparing all stores).",
    parameters: {
      type: "object",
      properties: { store: { type: "string", enum: [...STORES, "SUMMARY"] } },
      required: ["store"],
    },
  },
  {
    name: "filter_table",
    description:
      "Filter, hide or highlight rows of a data-explorer table in the dashboard. Give either `where` (a SQLite boolean expression over the table's columns) or `column` + `values` (rows whose column equals one of the values). Replaces the table's previous filters unless append=true. Returns how many rows matched.",
    parameters: {
      type: "object",
      properties: {
        table: { type: "string", enum: TABLES },
        mode: { type: "string", enum: ["show", "hide", "highlight"] },
        where: { type: "string", description: "SQLite boolean expression, e.g. email LIKE 's%' OR email LIKE 'p%'" },
        column: { type: "string", description: "Column for exact value matching (used with values)." },
        values: { type: "array", items: { type: "string" }, description: "Exact values to match in `column`." },
        label: { type: "string", description: "Short human description of the filter shown on the filter chip, e.g. 'E-mail starts with s or p'." },
        store: { type: "string", enum: STORES, description: "Optional: switch to this store first." },
        append: { type: "boolean", description: "Keep existing filters on this table and add this one (AND)." },
      },
      required: ["table", "mode", "label"],
    },
  },
  {
    name: "clear_filters",
    description: "Remove filters from one explorer table, or from all tables when table is omitted.",
    parameters: {
      type: "object",
      properties: { table: { type: "string", enum: TABLES } },
    },
  },
  {
    name: "sort_table",
    description: "Sort an explorer table by a column and show it.",
    parameters: {
      type: "object",
      properties: {
        table: { type: "string", enum: TABLES },
        column: { type: "string" },
        direction: { type: "string", enum: ["asc", "desc"] },
      },
      required: ["table", "column", "direction"],
    },
  },
  {
    name: "show_table",
    description: "Scroll to the data explorer and open one of its tables (without changing filters).",
    parameters: {
      type: "object",
      properties: { table: { type: "string", enum: TABLES } },
      required: ["table"],
    },
  },
  {
    name: "set_chart",
    description:
      "Control the daily revenue chart: zoom to a date range, change granularity, toggle the 7-day average line. Omitted fields stay unchanged; reset=true restores the full range at daily granularity.",
    parameters: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "YYYY-MM-DD" },
        end_date: { type: "string", description: "YYYY-MM-DD" },
        granularity: { type: "string", enum: ["day", "week", "month"] },
        show_average: { type: "boolean" },
        reset: { type: "boolean" },
      },
    },
  },
  {
    name: "set_theme",
    description: "Switch the dashboard between light and dark theme.",
    parameters: {
      type: "object",
      properties: { theme: { type: "string", enum: ["light", "dark"] } },
      required: ["theme"],
    },
  },
];

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// Accept only the shapes the client legitimately sends; drop anything else.
function sanitizeContents(contents) {
  if (!Array.isArray(contents)) return null;
  const out = [];
  for (const c of contents.slice(-MAX_CONTENTS)) {
    if (!c || (c.role !== "user" && c.role !== "model") || !Array.isArray(c.parts)) return null;
    const parts = c.parts.filter(
      (p) => p && (typeof p.text === "string" || p.functionCall || p.functionResponse),
    );
    if (parts.length) out.push({ role: c.role, parts });
  }
  // After slicing, the history must open with a real question, never with a model turn or an
  // orphaned functionResponse (Gemini rejects a response that doesn't follow its call).
  const isQuestion = (c) => c.role === "user" && c.parts.some((p) => typeof p.text === "string") && !c.parts.some((p) => p.functionResponse);
  while (out.length && !isQuestion(out[0])) out.shift();
  return out.length ? out : null;
}

function describeState(state) {
  if (!state || typeof state !== "object") return "unknown";
  return JSON.stringify(state).slice(0, 2000);
}

const GOOGLE_BASE = "https://generativelanguage.googleapis.com";

// GEMINI_BASE_URL (explicit) > GOOGLE_GEMINI_BASE_URL (injected by Netlify AI Gateway) > Google.
// Google stays last so a user's own AI Studio key still works when the gateway URL is injected.
function baseUrls() {
  const configured = Netlify.env.get("GEMINI_BASE_URL") || Netlify.env.get("GOOGLE_GEMINI_BASE_URL");
  return [...new Set([configured, GOOGLE_BASE].filter(Boolean).map((u) => u.replace(/\/+$/, "")))];
}

const isAuthError = (status, text) => status === 401 || status === 403 || (status === 400 && /API[_ ]KEY/i.test(text));

async function callGemini(model, apiKey, body) {
  let last;
  for (const base of baseUrls()) {
    const res = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    });
    if (res.ok) return res;
    const text = await res.text();
    last = new Response(text, { status: res.status });
    if (!isAuthError(res.status, text)) return last;
  }
  return last;
}

export default async (request) => {
  if (request.method !== "POST") return json(405, { error: "Use POST" });
  const apiKey = Netlify.env.get("GEMINI_API_KEY");
  if (!apiKey) return json(503, { error: "The assistant is not configured: GEMINI_API_KEY is missing on the server." });

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: "Conversation is too long. Start a new chat." });
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json(400, { error: "Invalid JSON" });
  }
  if (!payload || typeof payload !== "object") return json(400, { error: "Invalid request" });
  const contents = sanitizeContents(payload.contents);
  if (!contents) return json(400, { error: "No messages" });

  const models = (Netlify.env.get("GEMINI_MODELS") || DEFAULT_MODELS).split(",").map((m) => m.trim()).filter(Boolean);
  const thinkingLevel = Netlify.env.get("GEMINI_THINKING_LEVEL") || "low";
  const today = new Date().toISOString().slice(0, 10);

  const body = {
    systemInstruction: {
      parts: [{ text: `${SYSTEM_PROMPT}\n\n## Dashboard state\nToday is ${today}. ${describeState(payload.ui_state)}` }],
    },
    contents,
    tools: [{ functionDeclarations: TOOLS }],
    toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192, thinkingConfig: { thinkingLevel } },
  };

  const failures = [];
  for (const model of models) {
    let res = await callGemini(model, apiKey, body);
    if (res.status === 400) {
      // Some models reject a thinking level they don't support; retry once without it.
      const detail = await res.text();
      if (/thinking/i.test(detail)) {
        const { thinkingConfig, ...rest } = body.generationConfig;
        res = await callGemini(model, apiKey, { ...body, generationConfig: rest });
      } else {
        // The request itself is wrong; every other model would reject it the same way.
        return json(400, { error: "The assistant could not process this conversation. Start a new chat.", details: [`${model}: ${detail.slice(0, 300)}`] });
      }
    }
    if (res.ok) {
      const data = await res.json();
      const candidate = data.candidates?.[0];
      if (!candidate?.content?.parts?.length) {
        failures.push(`${model}: empty response (${candidate?.finishReason || data.promptFeedback?.blockReason || "unknown"})`);
        continue;
      }
      return json(200, {
        model,
        content: { role: "model", parts: candidate.content.parts },
        finishReason: candidate.finishReason,
        usage: data.usageMetadata,
      });
    }
    // 429 (quota), 404 (model unavailable to this key), 5xx: fall through to the next model.
    failures.push(`${model}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const quota = failures.some((f) => /: 429 /.test(f));
  return json(quota ? 429 : 502, {
    error: quota
      ? "The free Gemini quota is exhausted for now. Please try again in a minute."
      : "The language model is unavailable right now.",
    details: failures,
  });
};

export const config = { path: "/api/chat" };
