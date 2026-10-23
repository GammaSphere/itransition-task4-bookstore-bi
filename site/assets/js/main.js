import { STORES, openStore } from "./db.js";
import { RevenueChart, renderStoreComparison } from "./chart.js";
import { Explorer, TABLES } from "./explorer.js";
import { Chat } from "./chat.js";
import { createToolRunner } from "./tools.js";
import { escapeHtml, idArray, int, money, moneyCompact } from "./format.js";

const $ = (sel) => document.querySelector(sel);
const app = { metrics: null, active: "STORE1", comparisonChart: null };

// ------------------------------------------------------------------------------- theme

const THEME_KEY = "bookstore-bi-theme";
function storedTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}
function currentTheme() {
  return document.documentElement.getAttribute("data-bs-theme") === "dark" ? "dark" : "light";
}
function applyTheme(theme) {
  document.documentElement.setAttribute("data-bs-theme", theme);
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ }
  $("#theme-toggle i").className = `ti ${theme === "dark" ? "ti-sun" : "ti-moon"}`;
  if (app.metrics) {
    chart.render();
    if (app.active === "SUMMARY") renderSummary();
  }
}

// -------------------------------------------------------------------------- components

const chart = new RevenueChart($("#revenue-chart"), { onChange: syncChartControls });
const explorer = new Explorer($("#explorer"));

function syncChartControls(state) {
  document.querySelectorAll("[data-granularity]").forEach((b) => {
    b.classList.toggle("active", b.dataset.granularity === state.granularity);
  });
  const avg = $("#avg-toggle");
  avg.checked = chart.state.showAverage;
  avg.disabled = state.granularity !== "day";
  $("#chart-range").textContent = `${state.start_date} → ${state.end_date}`;
}

// ----------------------------------------------------------------------------- render

function renderTabs() {
  $("#store-tabs").innerHTML = ["SUMMARY", ...STORES].map((s) => `
    <li class="nav-item">
      <a class="nav-link ${s === app.active ? "active" : ""}" href="#${s}" data-store="${s}">
        <span class="nav-link-icon"><i class="ti ${s === "SUMMARY" ? "ti-layout-dashboard" : "ti-building-store"}"></i></span>
        <span class="nav-link-title">${s === "SUMMARY" ? "All stores" : s.replace("STORE", "Store ")}</span>
      </a>
    </li>`).join("");
}

function statCard({ label, value, sub, icon }) {
  return `
    <div class="col-6 col-xl-3">
      <div class="card card-sm h-100">
        <div class="card-body">
          <div class="d-flex align-items-center mb-1">
            <div class="subheader">${label}</div>
            <i class="ti ${icon} ms-auto text-secondary" aria-hidden="true"></i>
          </div>
          <div class="h1 mb-1 tabular">${value}</div>
          <div class="text-secondary small">${sub}</div>
        </div>
      </div>
    </div>`;
}

function renderStore(store) {
  const m = app.metrics[store];
  const t = m.totals;
  $("#page-title").textContent = `${store.replace("STORE", "Store ")} · Sales overview`;
  $("#page-pretitle").textContent = `${t.first_date} – ${t.last_date} · all amounts in USD (€1 = $1.20)`;

  $("#kpis").innerHTML = [
    statCard({ label: "Revenue", icon: "ti-currency-dollar", value: moneyCompact(t.revenue),
      sub: `${int(t.orders)} orders · ${int(t.items_sold)} books sold` }),
    statCard({ label: "Unique users", icon: "ti-users", value: int(m.unique_users),
      sub: `reconciled from ${int(m.user_records)} user records` }),
    statCard({ label: "Unique author sets", icon: "ti-users-group", value: int(m.unique_author_sets),
      sub: `${int(m.unique_authors)} individual authors · ${int(t.books)} books` }),
    statCard({ label: "Average order", icon: "ti-receipt", value: money(t.revenue / t.orders),
      sub: `${int(t.eur_orders)} orders paid in EUR` }),
  ].join("");

  const maxRev = m.top5_days[0].revenue;
  $("#top5").innerHTML = m.top5_days.map((d, i) => `
    <tr>
      <td class="text-secondary tabular">#${i + 1}</td>
      <td class="tabular fw-medium text-nowrap">${d.date}</td>
      <td class="w-50">
        <div class="d-flex align-items-center justify-content-end gap-2">
          <div class="progress progress-sm flex-fill d-none d-sm-flex" role="presentation"><div class="progress-bar" style="width:${(d.revenue / maxRev) * 100}%"></div></div>
          <span class="tabular text-end top5-value">${money(d.revenue)}</span>
        </div>
      </td>
      <td class="text-end text-secondary tabular">${int(d.orders)}</td>
    </tr>`).join("");

  $("#popular-author").innerHTML = m.most_popular_author_sets.map((s) => `
    <div class="popular-names">${s.authors.map((a) => `<span class="author-pill"><i class="ti ti-feather"></i>${escapeHtml(a)}</span>`).join("")}</div>
    <div class="d-flex gap-4 mt-3">
      <div><div class="subheader">Copies sold</div><div class="h2 m-0 tabular">${int(s.books_sold)}</div></div>
      <div><div class="subheader">Titles</div><div class="h2 m-0 tabular">${int(s.n_books)}</div></div>
      <div><div class="subheader">Revenue</div><div class="h2 m-0 tabular">${money(s.revenue)}</div></div>
    </div>
    <div class="text-secondary small mt-2">${s.authors.length > 1 ? "Co-author set: these authors wrote the books together." : "Single author."}</div>`).join('<hr class="my-3">') + `
    <div class="subheader mt-4 mb-2">Top author sets by copies sold</div>
    <table class="table table-sm table-borderless leaderboard m-0"><tbody>
      ${m.top_author_sets.map((s, i) => `
        <tr>
          <td class="text-secondary tabular">#${i + 1}</td>
          <td>${escapeHtml(s.authors.join(", "))}</td>
          <td class="text-end tabular fw-medium">${int(s.books_sold)}</td>
        </tr>`).join("")}
    </tbody></table>`;

  const b = m.best_buyer;
  // The most common value per field is the person's "usual" detail; others are the changes.
  const majority = Object.fromEntries(["name", "email", "phone", "address"].map((k) => {
    const counts = new Map();
    for (const r of b.records) counts.set(r[k], (counts.get(r[k]) || 0) + 1);
    return [k, [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0]];
  }));
  $("#best-buyer").innerHTML = `
    <div class="d-flex align-items-center gap-2 flex-wrap">
      <code class="id-array" id="best-buyer-ids">${idArray(b.user_ids)}</code>
      <button class="btn btn-sm btn-ghost-secondary btn-icon" data-copy="#best-buyer-ids" title="Copy ids" aria-label="Copy ids"><i class="ti ti-copy"></i></button>
    </div>
    <div class="d-flex gap-4 mt-3">
      <div><div class="subheader">Total spent</div><div class="h2 m-0 tabular">${money(b.total_spent)}</div></div>
      <div><div class="subheader">Orders</div><div class="h2 m-0 tabular">${int(b.orders)}</div></div>
      <div><div class="subheader">Records</div><div class="h2 m-0 tabular">${int(b.user_ids.length)}</div></div>
    </div>
    <div class="table-responsive mt-3">
      <table class="table table-sm table-borderless records-table m-0">
        <thead><tr><th>ID</th><th>Name</th><th>E-mail</th><th>Phone</th><th>Address</th></tr></thead>
        <tbody>${b.records.map((r) => `<tr>${["user_id", "name", "email", "phone", "address"].map((k) => {
          const changed = k !== "user_id" && r[k] !== majority[k];
          return `<td class="${changed ? "cell-changed" : ""}">${escapeHtml(r[k] ?? "—")}</td>`;
        }).join("")}</tr>`).join("")}</tbody>
      </table>
    </div>
    <div class="text-secondary small mt-1">Highlighted values differ from this person's usual details (the changed field of each record).</div>`;

  $("#static-chart-link").href = `charts/${store}_daily_revenue.png`;
  chart.setData(m.daily_revenue, m.top5_days);
}

function renderSummary() {
  $("#page-title").textContent = "All stores · Summary";
  $("#page-pretitle").textContent = "Answers for every store side by side";
  const rows = STORES.map((s) => {
    const m = app.metrics[s];
    return `
      <tr>
        <td><a href="#${s}" class="fw-medium">${s}</a></td>
        <td class="tabular small">${m.top5_days.map((d) => d.date).join("<br>")}</td>
        <td class="text-end tabular">${int(m.unique_users)}</td>
        <td class="text-end tabular">${int(m.unique_author_sets)}</td>
        <td>${m.most_popular_author_sets.map((x) => escapeHtml(x.authors.join(", "))).join("<br>")}</td>
        <td><code class="id-array">${idArray(m.best_buyer.user_ids)}</code></td>
        <td class="text-end tabular">${moneyCompact(m.totals.revenue)}</td>
      </tr>`;
  }).join("");
  $("#summary-table").innerHTML = rows;
  if (app.comparisonChart) app.comparisonChart.destroy();
  app.comparisonChart = renderStoreComparison($("#comparison-chart"), app.metrics, currentTheme());
}

async function activate(target) {
  if (target !== "SUMMARY" && !STORES.includes(target)) target = "STORE1";
  app.active = target;
  renderTabs();
  const isSummary = target === "SUMMARY";
  $("#view-store").hidden = isSummary;
  $("#view-summary").hidden = !isSummary;
  if (location.hash.slice(1) !== target) history.replaceState(null, "", `#${target}`);
  if (isSummary) {
    renderSummary();
    return;
  }
  renderStore(target);
  explorer.setStore(target, null);
  try {
    const db = await openStore(target);
    if (app.active === target) explorer.setStore(target, db);
  } catch (e) {
    $("#explorer").innerHTML = `<div class="card-body text-danger">${escapeHtml(e.message)}</div>`;
  }
}

// ----------------------------------------------------- controller used by assistant tools

async function ensureStoreView(store) {
  if (store && store !== app.active) await activate(store);
  if (app.active === "SUMMARY") await activate("STORE1");
  await openStore(app.active);
  if (!explorer.db) explorer.setStore(app.active, await openStore(app.active));
}

const ui = {
  async switchStore(store) {
    await activate(store);
    window.scrollTo({ top: 0, behavior: "smooth" });
    return { active_tab: app.active };
  },
  async filterTable(args) {
    await ensureStoreView(args.store);
    return { store: app.active, ...explorer.addFilter(args) };
  },
  async clearFilters(table) {
    await ensureStoreView();
    return { store: app.active, ...explorer.clearFilters(table) };
  },
  async sortTable(args) {
    await ensureStoreView();
    return { store: app.active, ...explorer.sortBy(args) };
  },
  async showTable(table) {
    await ensureStoreView();
    return { store: app.active, ...explorer.show(table) };
  },
  async setChart(args) {
    await ensureStoreView();
    const state = chart.update(args);
    $("#revenue-card").scrollIntoView({ behavior: "smooth", block: "start" });
    return { store: app.active, chart: state };
  },
  async setTheme(theme) {
    applyTheme(theme === "dark" ? "dark" : "light");
    return { theme: currentTheme() };
  },
};

function uiState() {
  return {
    active_tab: app.active,
    explorer: app.active === "SUMMARY" ? null : explorer.describe(),
    chart: app.active === "SUMMARY" ? null : chart.describe(),
    theme: currentTheme(),
  };
}

// ------------------------------------------------------------------------------- events

function bindEvents() {
  window.addEventListener("hashchange", () => {
    const target = location.hash.slice(1);
    if (app.metrics && target && target !== app.active) activate(target);
  });
  $("#theme-toggle").addEventListener("click", () => applyTheme(currentTheme() === "dark" ? "light" : "dark"));
  document.querySelectorAll("[data-granularity]").forEach((b) => b.addEventListener("click", () => chart.update({ granularity: b.dataset.granularity })));
  $("#avg-toggle").addEventListener("change", (e) => chart.update({ show_average: e.target.checked }));
  $("#chart-reset").addEventListener("click", () => chart.update({ reset: true }));
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-copy]");
    if (!btn) return;
    const text = $(btn.dataset.copy)?.textContent || "";
    navigator.clipboard?.writeText(text).then(() => {
      btn.innerHTML = '<i class="ti ti-check"></i>';
      setTimeout(() => (btn.innerHTML = '<i class="ti ti-copy"></i>'), 1200);
    });
  });
  const toggleChat = (open) => document.body.classList.toggle("chat-open", open);
  $("#chat-toggle").addEventListener("click", () => toggleChat(!document.body.classList.contains("chat-open")));
  $("#chat-close").addEventListener("click", () => toggleChat(false));
}

async function main() {
  const saved = storedTheme();
  applyTheme(saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  if (matchMedia("(min-width: 1200px)").matches) document.body.classList.add("chat-open");
  bindEvents();
  try {
    const res = await fetch("data/metrics.json");
    app.metrics = (await res.json()).stores;
  } catch (e) {
    $("#view-store").innerHTML = `<div class="alert alert-danger">Could not load metrics: ${escapeHtml(e.message)}</div>`;
    return;
  }
  const tools = createToolRunner({ getMetrics: () => app.metrics, ui });
  new Chat($("#chat-panel"), { tools, getUiState: uiState });
  await activate(location.hash.slice(1) || "STORE1");
  // Warm the remaining databases in the background so cross-store questions are fast.
  setTimeout(() => STORES.forEach((s) => openStore(s).catch(() => {})), 1500);
}

main();

export { TABLES };
