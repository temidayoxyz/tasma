/**
 * Tasma's bootstrap: chrome, tabs, polling loop and the small UI services the views
 * are handed (status line, toasts, confirmation dialogs).
 *
 * The polling loop is deliberately a self-scheduling `setTimeout` rather than an
 * `setInterval`: sampling can take longer than the interval on a busy machine, and
 * overlapping ticks would be worse than a slower refresh. It also stops entirely when
 * the window is hidden, because a monitor that burns CPU in the background is a bug.
 */

import { api, appInfo, isDesktop, mockAction, mockSnapshot } from "./api.js";
import { refreshPalette } from "./charts.js";
import { processesView } from "./processes.js";
import { DATA_VIEWS, HEAD, escapeHtml, setText } from "./views.js";
import * as fmt from "./format.js";

const VIEWS = {
  overview: DATA_VIEWS.overview,
  processes: processesView,
  cpu: DATA_VIEWS.cpu,
  memory: DATA_VIEWS.memory,
  network: DATA_VIEWS.network,
  disk: DATA_VIEWS.disk,
};

const state = {
  view: "overview",
  intervalMs: 1000,
  paused: false,
  mounted: new Map(),
  info: null,
  lastError: null,
  timer: null,
  ticks: 0,
};

/* --------------------------------------------------------------- services -- */

const element = (id) => document.getElementById(id);

function status(text) {
  const line = element("status-left");
  if (line.textContent !== text) line.textContent = text;
}

function toast(message, { tone = "good", action } = {}) {
  const host = element("toasts");
  const node = document.createElement("div");
  node.className = `toast is-${tone}`;
  node.innerHTML = `
    <svg><use href="#i-${tone === "good" ? "activity" : "alert"}"/></svg>
    <span class="toast-body">
      <span>${escapeHtml(message)}</span>
    </span>`;
  if (action) {
    const button = document.createElement("button");
    button.className = "btn is-ghost toast-action";
    button.type = "button";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      node.remove();
      action.run();
    });
    node.querySelector(".toast-body").appendChild(button);
  }
  host.appendChild(node);
  setTimeout(() => node.remove(), tone === "good" ? 5000 : 9000);
}

function confirmDialog({ title, body, confirmLabel = "Continue", danger = false }) {
  return new Promise((resolve) => {
    const modal = element("modal");
    const scrim = element("scrim");
    modal.innerHTML = `
      <h2 id="modal-title">${escapeHtml(title)}</h2>
      <p>${escapeHtml(body)}</p>
      <div class="actions">
        <button class="btn is-ghost" type="button" data-answer="no">Cancel</button>
        <button class="btn ${danger ? "is-danger" : "is-primary"}" type="button" data-answer="yes">${escapeHtml(confirmLabel)}</button>
      </div>`;
    const close = (answer) => {
      modal.hidden = true;
      scrim.hidden = true;
      modal.onkeydown = null;
      resolve(answer);
    };
    modal.querySelector('[data-answer="no"]').addEventListener("click", () => close(false));
    modal.querySelector('[data-answer="yes"]').addEventListener("click", () => close(true));
    modal.onkeydown = (event) => {
      if (event.key === "Escape") close(false);
      if (event.key === "Enter") close(true);
    };
    scrim.onclick = () => close(false);
    modal.hidden = false;
    scrim.hidden = false;
    modal.querySelector('[data-answer="yes"]').focus();
  });
}

function promptDialog({ title, body, value = "", label = "Run" }) {
  return new Promise((resolve) => {
    const modal = element("modal");
    const scrim = element("scrim");
    modal.innerHTML = `
      <h2 id="modal-title">${escapeHtml(title)}</h2>
      <p>${escapeHtml(body)}</p>
      <div class="field"><input type="text" value="${escapeHtml(value)}" spellcheck="false" aria-label="Command" /></div>
      <div class="actions">
        <button class="btn is-ghost" type="button" data-answer="no">Cancel</button>
        <button class="btn is-primary" type="button" data-answer="yes">${escapeHtml(label)}</button>
      </div>`;
    const input = modal.querySelector("input");
    const close = (answer) => {
      modal.hidden = true;
      scrim.hidden = true;
      resolve(answer ? input.value : null);
    };
    modal.querySelector('[data-answer="no"]').addEventListener("click", () => close(false));
    modal.querySelector('[data-answer="yes"]').addEventListener("click", () => close(true));
    modal.onkeydown = (event) => {
      if (event.key === "Escape") close(false);
      if (event.key === "Enter") close(true);
    };
    scrim.onclick = () => close(false);
    modal.hidden = false;
    scrim.hidden = false;
    input.focus();
    input.select();
  });
}

/** Shows a report from the backend, offering elevation when that is the blocker. */
function report(result) {
  if (!result) return;
  const tone = result.ok ? "good" : "bad";
  const action =
    result.needsElevation && !state.elevated
      ? {
          label: "Relaunch as administrator",
          run: () => relaunchElevated(),
        }
      : undefined;
  toast(result.message, { tone, action });
}

const ui = { status, toast, confirm: confirmDialog, prompt: promptDialog, report, refresh: schedule };

/* ----------------------------------------------------------- view plumbing -- */

function activate(name) {
  if (!VIEWS[name]) name = "overview";
  state.view = name;
  // Keep the hash in step so a view can be linked to and reloaded in place.
  if (window.location.hash.replace("#", "") !== name) {
    history.replaceState(null, "", `#${name}`);
  }

  for (const tab of document.querySelectorAll(".tab")) {
    const active = tab.dataset.view === name;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  for (const section of document.querySelectorAll(".view")) {
    section.classList.toggle("is-active", section.dataset.view === name);
  }

  // Mount lazily: a canvas measures zero while its section is hidden, so charts only
  // get created the first time a tab is actually opened.
  if (!state.mounted.has(name)) {
    const section = document.querySelector(`.view[data-view="${name}"]`);
    const viewState = VIEWS[name].mount(section, ui);
    state.mounted.set(name, viewState);
    if (state.lastSnapshot) VIEWS[name].update(section, state.lastSnapshot, viewState);
  }
}

function renderSnapshot(snapshot) {
  state.lastSnapshot = snapshot;
  const view = VIEWS[state.view];
  const viewState = state.mounted.get(state.view);
  if (!view || !viewState) return;

  const section = document.querySelector(`.view[data-view="${state.view}"]`);
  view.update(section, snapshot, viewState);

  setText(section, "host-chip", `${snapshot.host.name} · ${snapshot.host.os}`);
  const live = section.querySelector('[data-f="live"]');
  if (live) {
    live.classList.toggle("is-paused", state.paused || document.hidden);
    live.querySelector("span:last-child").textContent = state.paused ? "paused" : "live";
  }

  if (state.view !== "processes") {
    status(
      `${snapshot.counts.processes} processes · ${snapshot.counts.apps} apps · ` +
        `${snapshot.cpu.usage.toFixed(0)}% cpu · ${fmt.bytes(snapshot.memory.used)} in use · ` +
        `sampled ${fmt.clockNow(new Date(snapshot.ts))}`,
    );
  }

  state.elevated = Boolean(snapshot.host?.elevated);
  const chip = element("btn-elevate");
  chip.hidden = state.elevated;
  element("elevate-label").textContent = state.elevated
    ? "Administrator"
    : "Standard user · limited actions";
}

/* -------------------------------------------------------------- sampling -- */

function schedule() {
  clearTimeout(state.timer);
  state.timer = null;
  if (state.intervalMs > 0 && !state.paused && !document.hidden) state.timer = setTimeout(tick, 0);
}

async function tick() {
  const started = performance.now();
  try {
    const snapshot = isDesktop ? await api.snapshot() : mockSnapshot();
    state.lastError = null;
    renderSnapshot(snapshot);
    state.ticks += 1;
  } catch (error) {
    const message = String(error);
    if (message !== state.lastError) {
      state.lastError = message;
      toast(`Could not read the sampler: ${message}`, { tone: "bad" });
    }
  } finally {
    const elapsed = performance.now() - started;
    // Never queue a tick that would overlap the previous one.
    if (state.intervalMs > 0 && !state.paused && !document.hidden) {
      state.timer = setTimeout(tick, Math.max(150, state.intervalMs - elapsed));
    }
  }
}

function setRate(ms) {
  state.intervalMs = ms;
  state.paused = ms === 0;
  try {
    localStorage.setItem("tasma.rate", String(ms));
  } catch {
    // Private browsing / locked profile: the setting just will not persist.
  }
  schedule();
}

function toggleCompact() {
  const on = !document.body.classList.contains("compact");
  document.body.classList.toggle("compact", on);
  element("btn-compact").setAttribute("aria-pressed", String(on));
  (async () => {
    try {
      ui.report(isDesktop ? await api.setCompact(on) : mockAction(on ? "compact widget on" : "full dashboard"));
    } catch (error) {
      ui.toast(String(error), { tone: "bad" });
    }
  })();
}

async function relaunchElevated() {
  const yes = await confirmDialog({
    title: "Relaunch as administrator?",
    body: "Windows will ask for permission, then Tasma restarts with full access to processes owned by other users.",
    confirmLabel: "Restart as administrator",
  });
  if (!yes) return;
  try {
    ui.report(isDesktop ? await api.relaunchElevated() : mockAction("elevation"));
  } catch (error) {
    ui.toast(String(error), { tone: "bad" });
  }
}

/* ------------------------------------------------------------------ chrome -- */

function currentWindow() {
  const windowApi = window.__TAURI__?.window;
  return windowApi ? windowApi.getCurrentWindow() : null;
}

function ignore() {
  /* Window control calls can legitimately fail (e.g. during teardown). */
}

function onKey(event) {
  const meta = event.ctrlKey || event.metaKey;
  if (meta && event.key.toLowerCase() === "f") {
    event.preventDefault();
    activate("processes");
    state.mounted.get("processes")?.focusSearch(state.mounted.get("processes"));
    return;
  }
  if (meta && event.key.toLowerCase() === "r") {
    event.preventDefault();
    schedule();
    status("sampling…");
    return;
  }
  if (meta && /^[1-6]$/.test(event.key)) {
    event.preventDefault();
    activate(Object.keys(VIEWS)[Number(event.key) - 1]);
  }
}

function wireChrome() {
  element("btn-min").addEventListener("click", () => currentWindow()?.minimize().catch(ignore));
  element("btn-max").addEventListener("click", () => currentWindow()?.toggleMaximize().catch(ignore));
  element("btn-close").addEventListener("click", () => currentWindow()?.close().catch(ignore));
  element("btn-sample").addEventListener("click", () => {
    schedule();
    status("sampling…");
  });
  element("btn-compact").addEventListener("click", toggleCompact);
  element("btn-elevate").addEventListener("click", () => relaunchElevated());

  const select = element("rate-select");
  select.addEventListener("change", () => setRate(Number(select.value)));

  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => activate(tab.dataset.view));
  }
  document.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearTimeout(state.timer);
      state.timer = null;
    } else if (!state.timer) {
      schedule();
    }
  });
}

/* -------------------------------------------------------------------- boot -- */

async function boot() {
  const host = element("views");
  // Every template is built once; switching tabs then never re-parses markup.
  host.innerHTML = Object.entries(VIEWS)
    .map(
      ([name, view]) =>
        `<section class="view${name === "overview" ? " is-active" : ""}" data-view="${name}" role="tabpanel" aria-label="${escapeHtml(view.title)}">${HEAD(view.title, "")}${view.skeleton()}</section>`,
    )
    .join("");

  // `Number(null)` is 0, so a missing setting would silently start Tasma paused.
  const stored = localStorage.getItem("tasma.rate");
  const saved = stored === null ? Number.NaN : Number(stored);
  const select = element("rate-select");
  state.intervalMs = Number.isFinite(saved) && saved >= 0 ? saved : 1000;
  state.paused = state.intervalMs === 0;
  select.value = String(state.intervalMs);

  wireChrome();
  state.info = await appInfo();
  element("status-version").textContent = `Tasma ${state.info.version} · ${isDesktop ? "live" : "preview"}`;
  if (!isDesktop) {
    toast("Preview mode: this is mock data. Run `npm start` (cargo run) for the live sampler.", {
      tone: "bad",
    });
  }

  // Deep link: index.html#processes opens straight onto that view.
  const requested = window.location.hash.replace("#", "");
  activate(VIEWS[requested] ? requested : "overview");
  schedule();
}

window.addEventListener("hashchange", () => {
  const name = window.location.hash.replace("#", "");
  if (VIEWS[name] && name !== state.view) activate(name);
});

boot();
