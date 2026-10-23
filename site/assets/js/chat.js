// Chat panel: runs the tool-calling loop against /api/chat and executes tools locally.

import { escapeHtml, int } from "./format.js";

const MAX_STEPS = 10;
const KEEP_RESULT_CHARS = 2500;
const MAX_HISTORY_TURNS = 40;
const STEP_LIMIT_TEXT = "I stopped after too many steps. Please rephrase or narrow the question.";

const SUGGESTIONS = [
  "What are the top 5 days by revenue in STORE2?",
  "Compare the number of unique users across all stores",
  "Which genre brought the most revenue in 2026?",
  "Who is the best buyer in STORE3 and what are all their user ids?",
  "Select users with e-mails starting with s or p",
  "Filter out books that have people's names in the title",
  "Show monthly revenue for 2025 only",
];

const TOOL_LABELS = {
  get_store_metrics: "Read headline metrics",
  run_sql: "Ran SQL",
  switch_store: "Switched store",
  filter_table: "Filtered table",
  clear_filters: "Cleared filters",
  sort_table: "Sorted table",
  show_table: "Opened table",
  set_chart: "Updated chart",
  set_theme: "Changed theme",
};

function renderMarkdown(text) {
  const html = window.marked ? window.marked.parse(text, { breaks: true }) : escapeHtml(text);
  return window.DOMPurify ? window.DOMPurify.sanitize(html) : escapeHtml(text);
}

// Old tool results are only context for later turns; keep them short so requests stay small.
function compact(contents) {
  return contents.map((c) => {
    if (c.role !== "user" || !c.parts.some((p) => p.functionResponse)) return c;
    return {
      role: "user",
      parts: c.parts.map((p) => {
        if (!p.functionResponse) return p;
        const text = JSON.stringify(p.functionResponse.response);
        if (text.length <= KEEP_RESULT_CHARS) return p;
        return {
          functionResponse: {
            ...p.functionResponse,
            response: { truncated_preview: text.slice(0, KEEP_RESULT_CHARS), note: "Older result shortened; re-run the tool if exact values are needed." },
          },
        };
      }),
    };
  });
}

const isQuestion = (c) => c.role === "user" && c.parts.some((p) => typeof p.text === "string") && !c.parts.some((p) => p.functionResponse);

// Drop the oldest whole questions so a call/response pair is never split.
function trimHistory(contents) {
  if (contents.length <= MAX_HISTORY_TURNS) return contents;
  for (let i = contents.length - MAX_HISTORY_TURNS; i < contents.length; i++) {
    if (isQuestion(contents[i])) return contents.slice(i);
  }
  return [];
}

export class Chat {
  constructor(root, { tools, getUiState }) {
    this.root = root;
    this.tools = tools;
    this.getUiState = getUiState;
    this.contents = [];
    this.busy = false;
    this.log = root.querySelector("[data-chat-log]");
    this.form = root.querySelector("[data-chat-form]");
    this.input = root.querySelector("[data-chat-input]");
    this.sendBtn = root.querySelector("[data-chat-send]");

    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.send(this.input.value);
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.send(this.input.value);
      }
    });
    this.input.addEventListener("input", () => this.autosize());
    root.querySelector("[data-chat-reset]")?.addEventListener("click", () => this.reset());
    this.log.addEventListener("click", (e) => {
      const s = e.target.closest("[data-suggestion]");
      if (s) this.send(s.dataset.suggestion);
    });
    this.reset();
  }

  autosize() {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(this.input.scrollHeight, 160)}px`;
  }

  reset() {
    if (this.busy) return;
    this.contents = [];
    this.log.innerHTML = `
      <div class="chat-welcome">
        <div class="chat-welcome-title"><i class="ti ti-sparkles"></i> Ask about the data or tell me what to show</div>
        <p class="text-secondary small mb-2">Answers are computed with SQL over the cleaned store databases, never guessed. I can also filter, highlight and sort the tables, switch stores and zoom the chart.</p>
        <div class="d-flex flex-column gap-1">
          ${SUGGESTIONS.map((s) => `<button type="button" class="chat-suggestion" data-suggestion="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join("")}
        </div>
      </div>`;
  }

  setBusy(busy) {
    this.busy = busy;
    this.sendBtn.disabled = busy;
    this.input.disabled = busy;
    this.root.classList.toggle("is-busy", busy);
    if (!busy) this.input.focus();
  }

  scroll() {
    this.log.scrollTop = this.log.scrollHeight;
  }

  addBubble(role, html) {
    this.log.querySelector(".chat-welcome")?.remove();
    const el = document.createElement("div");
    el.className = `chat-msg chat-msg-${role}`;
    el.innerHTML = html;
    this.log.appendChild(el);
    this.scroll();
    return el;
  }

  addStep(call, result) {
    const label = TOOL_LABELS[call.name] || call.name;
    const args = call.args || {};
    let summary = "";
    if (call.name === "run_sql") summary = `${args.store}`;
    else if (call.name === "get_store_metrics") summary = args.store;
    else if (call.name === "filter_table") summary = `${args.table} · ${args.mode} · ${args.label || ""}`;
    else if (args.table || args.store || args.theme) summary = args.table || args.store || args.theme;
    const failed = result && result.error;
    const rows = result?.row_count != null ? ` → ${int(result.row_count)} row${result.row_count === 1 ? "" : "s"}` : "";
    const matched = result?.matched_rows != null ? ` → ${int(result.matched_rows)} matched` : "";
    const el = document.createElement("details");
    el.className = `chat-step ${failed ? "chat-step-error" : ""}`;
    el.innerHTML = `
      <summary><i class="ti ${failed ? "ti-alert-triangle" : "ti-tool"}"></i>
        <span>${escapeHtml(label)}</span><span class="text-secondary">${escapeHtml(summary)}${rows}${matched}</span></summary>
      ${args.sql ? `<pre class="chat-sql">${escapeHtml(args.sql)}</pre>` : `<pre class="chat-sql">${escapeHtml(JSON.stringify(args, null, 1))}</pre>`}
      <pre class="chat-result">${escapeHtml(JSON.stringify(result, null, 1).slice(0, 1500))}</pre>`;
    this.currentSteps.appendChild(el);
    this.scroll();
  }

  async callModel(retry = true) {
    const res = await fetch("api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: this.contents, ui_state: this.getUiState() }),
    });
    let data = null;
    try {
      data = await res.json(); // the edge function streams heartbeat spaces before the JSON
    } catch {
      /* non-JSON error page */
    }
    // Model calls report their real status inside the streamed body.
    const status = data?.status ?? res.status;
    // A cold model gateway can fail once; the second attempt is normally fast.
    if (retry && [500, 502, 504].includes(status)) return this.callModel(false);
    if (status !== 200 || !data?.content) {
      if (data?.details) console.warn("Assistant error details:", data.details);
      throw new Error(data?.error || `The assistant is unavailable (HTTP ${res.status}).`);
    }
    return data;
  }

  async send(text) {
    text = String(text || "").trim();
    if (!text || this.busy) return;
    this.input.value = "";
    this.autosize();
    this.addBubble("user", escapeHtml(text).replace(/\n/g, "<br>"));
    this.contents = trimHistory(compact(this.contents));
    this.contents.push({ role: "user", parts: [{ text }] });

    const reply = this.addBubble("assistant", '<div class="chat-steps"></div><div class="chat-text"><span class="chat-typing"><span></span><span></span><span></span></span></div>');
    this.currentSteps = reply.querySelector(".chat-steps");
    const textEl = reply.querySelector(".chat-text");
    this.setBusy(true);
    const startLength = this.contents.length;
    try {
      let finalText = "";
      let finished = false;
      for (let step = 0; step < MAX_STEPS; step++) {
        const data = await this.callModel();
        const content = data.content;
        this.contents.push(content); // verbatim, so thought signatures survive
        const calls = content.parts.filter((p) => p.functionCall).map((p) => p.functionCall);
        const texts = content.parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text);
        if (texts.join("").trim()) finalText = texts.join("");
        if (!calls.length) {
          finished = true;
          break;
        }
        const responses = [];
        for (const call of calls) {
          const result = await this.tools.execute(call.name, call.args || {});
          this.addStep(call, result);
          const fr = { name: call.name, response: result && typeof result === "object" && !Array.isArray(result) ? result : { result } };
          if (call.id) fr.id = call.id;
          responses.push({ functionResponse: fr });
        }
        this.contents.push({ role: "user", parts: responses });
      }
      if (!finished) {
        // Close the turn with a model message so the history stays call -> response -> answer.
        finalText = STEP_LIMIT_TEXT;
        this.contents.push({ role: "model", parts: [{ text: finalText }] });
      }
      textEl.innerHTML = renderMarkdown(finalText || "Done.");
    } catch (e) {
      // Drop the failed turn so the conversation stays valid for the next attempt.
      this.contents = this.contents.slice(0, startLength - 1);
      textEl.innerHTML = `<div class="text-danger"><i class="ti ti-alert-circle me-1"></i>${escapeHtml(e.message)}</div>`;
    } finally {
      this.setBusy(false);
      this.scroll();
    }
  }
}
