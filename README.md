# Bookstore BI: Task 4

A sales dashboard for five book stores, with a built-in AI analyst.

- **Part 1:** a pandas pipeline cleans the raw data and computes the metrics. A BI dashboard has one tab per store plus an "All stores" summary.
- **Part 2:** you can ask questions in natural language. The model (Google Gemini) never sees the raw data. It answers by calling tools that run exact SQL over the cleaned per-store databases.
- **Part 3:** the same assistant operates the dashboard. It can filter, hide, highlight and sort tables, switch stores, zoom and re-bucket the chart, and switch the theme.

Live dashboard: _see the Netlify URL in the repository description_

## Results

| Store | Top 5 days by revenue | Unique users | Unique author sets | Most popular author set | Best buyer ids |
| --- | --- | --- | --- | --- | --- |
| STORE1 | 2025-08-20, 2025-09-22, 2026-01-15, 2025-09-03, 2025-10-17 | 3221 | 324 | Darron Ernser, Miss Lorina Kertzmann (173 sold) | [48403, 48904, 50056] |
| STORE2 | 2025-11-16, 2025-12-12, 2025-12-10, 2025-09-19, 2025-11-19 | 3166 | 281 | Kenneth Hamill, Marcus McKenzie (176 sold) | [51014] |
| STORE3 | 2025-10-09, 2025-09-21, 2025-09-04, 2025-09-30, 2025-09-01 | 2955 | 307 | Loreta Metz (155 sold) | [52881, 53869, 54846] |
| STORE4 | 2025-11-24, 2025-11-17, 2025-11-28, 2025-11-13, 2025-09-21 | 2850 | 299 | Emil Rempel, Heriberto Kutch, Merle Rice (198 sold) | [53347, 54809] |
| STORE5 | 2025-10-20, 2025-11-28, 2025-09-27, 2025-10-17, 2025-12-05 | 2987 | 311 | Dulcie Bode (169 sold) | [52895, 53969] |

The daily revenue charts are rendered with matplotlib in [`site/charts/`](site/charts/), and interactively in the dashboard.

## Data cleaning (`etl/`)

| Problem in the raw data | Handling |
| --- | --- |
| `unit_price` in 8 notations: `$ 35`, `30.0USD`, `USD25.25`, `29.$`, `EUR37.50`, `€ 9.5`, `$20¢25`, `46$99¢` … | `parse_price` returns an exact `Decimal` amount and the currency. EUR is converted at €1 = $1.20 and rounded to cents (half-up). `paid_price = quantity × unit_price_usd`. |
| `timestamp` in ~160 layouts: ISO, `DD.MM.YYYY`, `MM/DD/YY`, `D-Mon-YYYY` (Mon / MON / Month), ctime, 12h with `AM`/`am`/`A.M.`, date and time in either order, `,`/`;`/space separators | `parse_timestamp` finds the time, then matches the remaining date against known patterns. Slash dates are verified as month-first (the first part is never > 12) and dot dates as day-first. |
| Null markers `NULL`, empty, whitespace, `-`, tab in addresses, publisher, year and shipping | Normalized to real nulls. |
| Phones in 4 formats | Compared on their 10 digits. |
| Duplicate ids, malformed rows, orphan foreign keys | Checked and reported in `metrics.json → cleaning`. None were found after parsing; every price and timestamp parses. |

**Real users.** Two user records belong to the same person when they agree on at least 3 of the 4 fields (name, address, phone, e-mail), i.e. at most one field changed. The task guarantees only one field changes at a time. The pipeline indexes every record under its 4 leave-one-field-out keys and merges matches with union-find, so chains (phone changed, then e-mail changed) end up in one group. Missing values never count as a match. The result does not change if titles are stripped from names or if empty addresses are treated as wildcards.

**Author sets.** Each book's author string is split on commas and normalized into a sorted set, so "Paul, John" is the same set as "John, Paul". The most popular author set is the set with the highest `SUM(quantity)` sold.

**Best buyer.** Spending is summed per real person. The answer lists every `user_id` of that person.

Run it:

```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # (bin/ on macOS/Linux)
.venv/Scripts/python -m pytest -q        # parser + reconciliation tests
.venv/Scripts/python -m etl.pipeline     # -> site/data/metrics.json, site/data/STORE*.sqlite.gz, site/charts/*.png
```

## Dashboard (`site/`)

The dashboard is a static page built on the **Tabler** admin template with **ApexCharts**. It has:

- KPI tiles, the top-5 revenue days, the most popular author set with a leaderboard, and the best buyer with all their records (the changed field of each record is highlighted).
- The daily revenue chart, with zoom, a day/week/month toggle, a 7-day average line and the top 5 days marked.
- A data explorer for books, users, customers (reconciled people) and orders, with search, sorting, paging and CSV export.

The explorer is backed by **sql.js**: each store's SQLite database, produced by the pipeline, is loaded in the browser.

## AI analyst (`netlify/edge-functions/chat.js`, `site/assets/js/chat.js`, `tools.js`)

```text
browser (agent loop) ──contents──▶ Netlify Edge Function ──▶ Gemini generateContent
        ▲   │                     (API key, system prompt,
        │   └─ executes tool calls  tool declarations)
        │      locally: SQL on the store DB / dashboard actions
        └──── functionResponse ───┘
```

The model gets only the schema and these tools. Every number comes from a tool result.

| Tool | What it does |
| --- | --- |
| `get_store_metrics(store\|ALL)` | The precomputed headline answers. |
| `run_sql(store\|ALL, sql, max_rows)` | One read-only SELECT on a store's SQLite DB. `ALL` runs the query in each store separately. Errors are returned to the model so it can fix its query. |
| `filter_table(table, mode=show\|hide\|highlight, where \| column+values, label)` | Drives the explorer. Pattern conditions become SQL (`email LIKE 's%' OR email LIKE 'p%'`). For judgement calls like "titles with people's names", the model first lists the titles with `run_sql`, decides which ones match, and passes the exact values. Each filter appears as a chip with its match count and can be inverted or removed. |
| `clear_filters`, `sort_table`, `show_table`, `switch_store`, `set_chart`, `set_theme` | Other dashboard controls. |

Each step the assistant takes (the SQL and its result, or the UI action) is shown in the chat, so you can check every answer.

## Deploy (Netlify)

1. Connect the repo to Netlify (or run `netlify deploy --prod`). `netlify.toml` publishes `site/` and registers the edge function.
2. Choose how to pay for the model:
   - **No setup:** on Netlify's credit-based plans, the AI Gateway injects `GEMINI_API_KEY` and `GOOGLE_GEMINI_BASE_URL` automatically, and the function uses them. Usage is billed to your Netlify credits.
   - **Your own key:** set `GEMINI_API_KEY` to a free Google AI Studio key. If the gateway URL is still injected and rejects the key, the function falls back to calling Google directly.
3. Optional settings:
   - `GEMINI_MODELS`: a comma-separated fallback list. The default is `gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash-lite`. When a model returns quota or availability errors, the next one is used.
   - `GEMINI_THINKING_LEVEL`: the thinking level, `low` by default.
   - `GEMINI_BASE_URL`: forces a specific API base URL.
