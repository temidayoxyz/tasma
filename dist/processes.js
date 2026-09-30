/**
 * Processes: the table people actually came for.
 *
 * Three things worth knowing about how this is built:
 *
 * * **Virtualised with a row pool.** A row is created once per pid and then reused, so
 *   a 250-row list that re-sorts every second does not throw away 250 DOM nodes, lose
 *   the hover state or move the selection around.
 * * **Sorting is stable.** `sortProcesses` breaks ties on the pid, so equal values
 *   never swap places between ticks.
 * * **Actions are honest.** Every action returns a report; when Windows refuses
 *   because the process belongs to another user, the toast offers the elevation path
 *   instead of pretending it worked.
 */

import { api, isDesktop, mockAction, mockDetail } from "./api.js";
import * as fmt from "./format.js";
import {
  COLUMNS,
  ROW_HEIGHT,
  appName,
  filterProcesses,
  sortProcesses,
  summarise,
  virtualWindow,
} from "./table.js";
import { escapeHtml } from "./views.js";

const PRIORITIES = ["Idle", "Below normal", "Normal", "Above normal", "High", "Realtime"];

export const processesView = {
  id: "processes",
  title: "Processes",

  skeleton: () => `
    <div class="grid">
      <section class="card table-card span-3">
        <div class="toolbar">
          <label class="search">
            <svg><use href="#i-search"/></svg>
            <input id="proc-search" type="search" autocomplete="off" spellcheck="false"
                   placeholder="Filter by name, PID, user or path" aria-label="Filter processes" />
          </label>
          <span class="chip" data-f="count">—</span>
          <span class="spacer"></span>
          <button class="btn" type="button" data-a="scale" aria-pressed="false">CPU: share of machine</button>
          <button class="btn" type="button" data-a="run"><svg><use href="#i-play"/></svg>Run new task</button>
          <button class="btn is-primary" type="button" data-a="end" disabled><svg><use href="#i-power"/></svg>End task</button>
          <button class="btn is-danger" type="button" data-a="kill" disabled>Force terminate</button>
          <button class="btn is-ghost" type="button" data-a="suspend" disabled>Suspend</button>
          <button class="btn is-ghost" type="button" data-a="resume" disabled>Resume</button>
          <button class="btn is-ghost" type="button" data-a="efficiency" disabled>Efficiency mode</button>
          <button class="btn is-ghost" type="button" data-a="priority" disabled>Priority</button>
        </div>
        <div class="table-scroll" data-f="scroll" tabindex="0" role="region" aria-label="Process list">
          <div class="thead" data-f="head" role="row"></div>
          <div class="tbody" data-f="body" role="rowgroup"></div>
        </div>
      </section>
    </div>
    <p class="note">End task asks the app's windows to close, like clicking its X. Force terminate is the Task Manager's "End process" — unsaved work goes away.</p>`,

  mount(root, ui) {
    const state = {
      ui,
      root,
      scroll: root.querySelector('[data-f="scroll"]'),
      head: root.querySelector('[data-f="head"]'),
      body: root.querySelector('[data-f="body"]'),
      search: root.querySelector("#proc-search"),
      sortKey: "cpu",
      sortDir: "desc",
      cpuScale: "total",
      query: "",
      selectedPid: null,
      snapshot: null,
      visible: [],
      rows: new Map(),
      window: { start: 0, end: 0, height: 0 },
    };

    paintHead(state);

    state.head.addEventListener("click", (event) => {
      const button = event.target.closest("[data-sort]");
      if (!button) return;
      const key = button.dataset.sort;
      // Numeric columns default to biggest-first, names to A-Z.
      const fallback = key === "name" || key === "status" ? "asc" : "desc";
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortKey = key;
        state.sortDir = fallback;
      }
      paintHead(state);
      render(state);
    });

    state.search.addEventListener("input", () => {
      state.query = state.search.value;
      state.scroll.scrollTop = 0;
      render(state);
    });

    state.scroll.addEventListener("scroll", () => {
      // Scroll events arrive in bursts: only re-slice when the window really moved.
      const next = virtualWindow({
        scrollTop: state.scroll.scrollTop,
        viewportHeight: state.scroll.clientHeight,
        total: state.visible.length,
      });
      if (next.start !== state.window.start || next.end !== state.window.end) render(state);
    });

    window.addEventListener("resize", () => render(state));
    state.body.addEventListener("click", onRowClick(state));
    state.body.addEventListener("dblclick", onRowDoubleClick(state));
    state.body.addEventListener("contextmenu", onRowContextMenu(state));
    state.body.addEventListener("keydown", onRowKeyDown(state));

    // The menu and the drawer live in the shell, outside this view, so they are
    // dismissed at document level. Mounting happens once per tab, so no duplicates.
    document.addEventListener("click", (event) => {
      if (!event.target.closest("#ctx")) closeMenu();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeMenu();
        closeDrawer();
      }
    });

    root.querySelector('[data-a="scale"]').addEventListener("click", (event) => {
      state.cpuScale = state.cpuScale === "total" ? "perCore" : "total";
      const button = event.currentTarget;
      button.setAttribute("aria-pressed", String(state.cpuScale === "perCore"));
      button.textContent =
        state.cpuScale === "total" ? "CPU: share of machine" : "CPU: share of one core";
      render(state);
    });

    root.querySelector('[data-a="run"]').addEventListener("click", () => runTask(state));
    const buttons = {
      end: () => act(state, "end"),
      kill: () => act(state, "kill"),
      suspend: () => act(state, "suspend"),
      resume: () => act(state, "resume"),
      efficiency: () => act(state, "efficiency"),
      priority: () => openPriorityMenu(state),
    };
    for (const [action, handler] of Object.entries(buttons)) {
      root.querySelector(`[data-a="${action}"]`).addEventListener("click", handler);
    }

    return state;
  },

  update(root, snapshot, state) {
    state.snapshot = snapshot;
    render(state);
  },

  focusSearch(state) {
    state.search.focus();
    state.search.select();
  },
};

function paintHead(state) {
  state.head.innerHTML = COLUMNS.map(
    (column) => `
      <button type="button" data-sort="${column.key}" class="${column.align === "right" ? "num right" : ""}"
              aria-sort="${column.key === state.sortKey ? (state.sortDir === "asc" ? "ascending" : "descending") : "none"}">${column.label}</button>`,
  ).join("");
}

/* --------------------------------------------------------------- the rows -- */

function selected(state) {
  if (state.selectedPid == null || !state.snapshot) return null;
  return state.snapshot.processes.find((process) => process.pid === state.selectedPid) || null;
}

function createRow() {
  const node = document.createElement("div");
  node.className = "trow";
  node.setAttribute("role", "row");
  node.setAttribute("tabindex", "-1");
  node.innerHTML = `
    <span class="tcell tcell-name">
      <span class="tile"></span>
      <span class="name-block"><div class="row-title"></div><div class="row-sub"></div></span>
    </span>
    <span class="tcell num" data-c="pid"></span>
    <span class="tcell num" data-c="cpu"></span>
    <span class="tcell num" data-c="memory"></span>
    <span class="tcell num" data-c="disk"></span>
    <span class="tcell num" data-c="gpu"></span>
    <span class="tcell num" data-c="threads"></span>
    <span class="tcell num" data-c="status"></span>
    <span class="row-actions">
      <button class="icon-btn" type="button" data-row="end" title="End task" aria-label="End task"><svg><use href="#i-power"/></svg></button>
      <button class="icon-btn" type="button" data-row="suspend" title="Suspend or resume" aria-label="Suspend or resume"><svg><use href="#i-pause"/></svg></button>
      <button class="icon-btn" type="button" data-row="menu" title="More actions" aria-label="More actions"><svg><use href="#i-chevron"/></svg></button>
    </span>`;

  const cells = {};
  for (const cell of node.querySelectorAll("[data-c]")) cells[cell.dataset.c] = cell;
  return {
    node,
    cells,
    tile: node.querySelector(".tile"),
    title: node.querySelector(".row-title"),
    sub: node.querySelector(".row-sub"),
  };
}

function paintRow(row, process, state, index) {
  const name = appName(process);
  row.node.style.top = `${index * ROW_HEIGHT}px`;
  row.node.dataset.pid = String(process.pid);

  if (row.tile.textContent !== fmt.initials(name)) {
    row.tile.textContent = fmt.initials(name);
    row.tile.style.background = fmt.tileColour(name);
  }
  row.title.textContent = name;
  row.sub.textContent =
    process.description && process.description !== process.name
      ? process.name
      : `${process.user || "—"}`;

  const io = (process.readBps || 0) + (process.writeBps || 0);
  row.cells.pid.textContent = String(process.pid);
  row.cells.cpu.textContent = fmt.pct(process.cpu, 2);
  row.cells.cpu.dataset.heat = fmt.heat(process.cpu);
  row.cells.memory.textContent = fmt.bytes(process.memory);
  row.cells.disk.textContent = io > 0 ? fmt.rate(io) : "—";
  row.cells.gpu.textContent = process.gpu == null ? "—" : fmt.pct(process.gpu, 1);
  row.cells.threads.textContent = process.threads == null ? "—" : String(process.threads);
  row.cells.status.textContent = process.status;

  row.node.classList.toggle("is-suspended", process.status === "Suspended");
  row.node.classList.toggle("is-selected", process.pid === state.selectedPid);
  row.node.classList.toggle("is-self", process.pid === state.selfPid);
  row.node.setAttribute("aria-selected", String(process.pid === state.selectedPid));
  row.node.title = [
    process.exe || process.name,
    `user ${process.user || "—"}`,
    process.session != null ? `session ${process.session}` : null,
    process.priority ? `priority ${process.priority}` : null,
    process.handles != null ? `${process.handles} handles` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function render(state) {
  const snapshot = state.snapshot;
  if (!snapshot) return;

  state.selfPid = snapshot.host?.selfPid ?? null;
  const filtered = filterProcesses(snapshot.processes, state.query);
  state.visible = sortProcesses(filtered, state.sortKey, state.sortDir, state.cpuScale);

  const slice = virtualWindow({
    scrollTop: state.scroll.scrollTop,
    viewportHeight: state.scroll.clientHeight || 480,
    total: state.visible.length,
  });
  state.window = slice;
  state.body.style.height = `${slice.height}px`;

  const wanted = new Set();
  for (let index = slice.start; index < slice.end; index += 1) {
    const process = state.visible[index];
    if (!process) continue;
    wanted.add(process.pid);
    let row = state.rows.get(process.pid);
    if (!row) {
      row = createRow();
      state.rows.set(process.pid, row);
      state.body.appendChild(row.node);
    }
    paintRow(row, process, state, index);
  }

  // The pool stays the size of the viewport, not the size of the process table.
  for (const [pid, row] of state.rows) {
    if (!wanted.has(pid)) {
      row.node.remove();
      state.rows.delete(pid);
    }
  }

  if (!state.visible.length) {
    if (!state.empty) {
      state.empty = document.createElement("p");
      state.empty.className = "empty";
      state.body.appendChild(state.empty);
    }
    state.empty.textContent = "Nothing matches that filter.";
  } else if (state.empty) {
    state.empty.remove();
    state.empty = null;
  }

  const summary = summarise(filtered, snapshot.intervalMs);
  state.root.querySelector('[data-f="count"]').textContent =
    `${summary.processes} shown of ${snapshot.processes.length}`;
  state.ui.status(
    `${snapshot.counts.processes} processes · ${snapshot.counts.apps} apps · ` +
      `${fmt.bytes(summary.resident)} resident · ${snapshot.counts.threads.toLocaleString()} threads · ` +
      `${snapshot.counts.handles.toLocaleString()} handles`,
  );

  setActionsEnabled(state, selected(state));
}

function setActionsEnabled(state, process) {
  // The kernel pseudo-processes are not controllable, and Tasma will not act on
  // itself - the same rule the Rust side enforces.
  const controlled = Boolean(process) && process.pid > 4 && process.pid !== state.selfPid;
  const suspended = process?.status === "Suspended";

  const button = (name) => state.root.querySelector(`[data-a="${name}"]`);
  button("end").disabled = !controlled;
  button("kill").disabled = !controlled;
  button("suspend").disabled = !controlled || suspended;
  button("resume").disabled = !controlled || !suspended;
  button("efficiency").disabled = !controlled;
  button("priority").disabled = !controlled;
  button("efficiency").setAttribute(
    "aria-pressed",
    String(Boolean(process && state.efficiency?.has(process.pid))),
  );
}

/* ----------------------------------------------------------- interaction -- */

function pidFrom(event) {
  const row = event.target.closest(".trow");
  return row ? Number(row.dataset.pid) : null;
}

function focusRow(state, pid) {
  requestAnimationFrame(() => state.body.querySelector(`.trow[data-pid="${pid}"]`)?.focus());
}

function onRowClick(state) {
  return (event) => {
    const pid = pidFrom(event);
    if (pid == null) return;
    const rowAction = event.target.closest("[data-row]");
    // Clicking a selected row again clears the selection, which is how you get the
    // toolbar back to a neutral state without hunting for an empty spot.
    state.selectedPid = state.selectedPid === pid ? null : pid;

    if (rowAction) {
      event.stopPropagation();
      state.selectedPid = pid;
      const process = selected(state);
      const action = rowAction.dataset.row;
      if (action === "end") {
        act(state, "end");
      } else if (action === "suspend") {
        act(state, process?.status === "Suspended" ? "resume" : "suspend");
      } else {
        const rect = rowAction.getBoundingClientRect();
        openProcessMenu(state, rect.right - 210, rect.bottom + 4);
      }
      return;
    }

    render(state);
    if (state.selectedPid != null) focusRow(state, pid);
  };
}

function onRowDoubleClick(state) {
  return (event) => {
    if (pidFrom(event) == null) return;
    openDrawer(state);
  };
}

function onRowContextMenu(state) {
  return (event) => {
    const pid = pidFrom(event);
    if (pid == null) return;
    event.preventDefault();
    state.selectedPid = pid;
    render(state);
    openProcessMenu(state, event.clientX, event.clientY);
  };
}

function onRowKeyDown(state) {
  return (event) => {
    const pid = pidFrom(event);
    if (pid == null) return;
    const index = state.visible.findIndex((process) => process.pid === pid);
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;

    if (step) {
      event.preventDefault();
      const next = state.visible[index + step];
      if (next) {
        state.selectedPid = next.pid;
        render(state);
        focusRow(state, next.pid);
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      openDrawer(state);
    } else if (event.key === "Delete") {
      event.preventDefault();
      act(state, "end");
    }
  };
}

async function run(state, work) {
  try {
    const result = await work;
    state.ui.report(result);
    // Pull a fresh sample straight away so the list reflects what just happened
    // instead of waiting out the rest of the refresh interval.
    state.ui.refresh();
  } catch (error) {
    state.ui.toast(String(error), { tone: "bad" });
  }
}

async function act(state, action) {
  const process = selected(state);
  if (!process) return undefined;
  const name = appName(process);
  state.efficiency ??= new Set();

  if (action === "end") {
    const yes = await state.ui.confirm({
      title: `End ${name}?`,
      body:
        `Tasma asks PID ${process.pid} to close its windows, exactly like clicking the X on ` +
        "its title bar. If it ignores that, force terminate is right next to it.",
      confirmLabel: "End task",
    });
    if (!yes) return undefined;
    return run(state, isDesktop ? api.endTask(process.pid) : mockAction("end task", name));
  }

  if (action === "kill") {
    const yes = await state.ui.confirm({
      title: `Force terminate ${name}?`,
      body: `PID ${process.pid} stops immediately and unsaved work is lost. This is the Task Manager's "End process".`,
      confirmLabel: "Force terminate",
      danger: true,
    });
    if (!yes) return undefined;
    return run(state, isDesktop ? api.kill(process.pid) : mockAction("force terminate", name));
  }

  if (action === "suspend") {
    return run(state, isDesktop ? api.suspend(process.pid) : mockAction("suspend", name));
  }
  if (action === "resume") {
    return run(state, isDesktop ? api.resume(process.pid) : mockAction("resume", name));
  }
  if (action === "efficiency") {
    const enable = !state.efficiency.has(process.pid);
    return run(
      state,
      (async () => {
        const result = isDesktop
          ? await api.setEfficiency(process.pid, enable)
          : mockAction("efficiency mode", name);
        if (result.ok) {
          if (enable) state.efficiency.add(process.pid);
          else state.efficiency.delete(process.pid);
        }
        return result;
      })(),
    );
  }
  return undefined;
}

async function setPriority(state, level) {
  const process = selected(state);
  if (!process) return;
  closeMenu();
  return run(
    state,
    isDesktop ? api.setPriority(process.pid, level) : mockAction(`priority ${level}`, appName(process)),
  );
}

function openPriorityMenu(state) {
  const process = selected(state);
  if (!process) return;
  const rect = state.root.querySelector('[data-a="priority"]').getBoundingClientRect();
  openProcessMenu(state, Math.max(8, rect.right - 214), rect.bottom + 6, {
    title: `Priority for ${appName(process)}`,
    items: PRIORITIES.map((level) => ({
      label: level,
      icon: "layers",
      run: () => setPriority(state, level),
    })),
  });
}

async function copyText(state, text, message) {
  if (!text) {
    state.ui.toast("There is nothing to copy for that process.", { tone: "bad" });
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    state.ui.toast(message, { tone: "good" });
  } catch {
    state.ui.toast("The clipboard is not available here.", { tone: "bad" });
  }
}

async function runTask(state) {
  const command = await state.ui.prompt({
    title: "Run new task",
    body: "Tasma starts the command line in its own console window, like the Task Manager's Run task.",
    label: "Run",
  });
  if (!command) return;
  return run(state, isDesktop ? api.runTask(command) : mockAction(`run ${command}`));
}

/* ------------------------------------------------------ process context menu --
 * In 0.1.0 the menu lived here rather than in a shared component.
 */

let dismissMenu = null;

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

function showMenu(state, items, heading, x, y) {
  const menu = document.getElementById("ctx");
  if (!menu || !items?.length) return;

  menu.innerHTML =
    `<div class="head">${escapeHtml(heading)}</div>` +
    items
      .map((item, index) =>
        item.separator
          ? '<div class="sep"></div>'
          : `<button type="button" class="${item.danger ? "is-danger" : ""}" data-i="${index}"><svg><use href="#i-${item.icon || "activity"}"/></svg><span>${escapeHtml(item.label)}</span></button>`,
      )
      .join("");

  menu.hidden = false;
  menu.style.left = `${clamp(x, 8, window.innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${clamp(y, 8, window.innerHeight - menu.offsetHeight - 8)}px`;

  const stop = () => {
    menu.hidden = true;
    menu.onclick = null;
    dismissMenu = null;
  };

  menu.onclick = (event) => {
    const button = event.target.closest("[data-i]");
    if (!button) return;
    const item = items[Number(button.dataset.i)];
    stop();
    item?.run?.();
  };

  dismissMenu = (event) => {
    if (event.type === "keydown" && event.key !== "Escape") return;
    if (event.type === "click" && event.target.closest("#ctx")) return;
    stop();
  };
  document.addEventListener("click", dismissMenu, true);
  document.addEventListener("keydown", dismissMenu, true);
}

function closeMenu() {
  dismissMenu?.(new KeyboardEvent("keydown", { key: "NotEscape" }));
}


function openProcessMenu(state, x, y, options = {}) {
  const process = selected(state);
  if (!process) return;
  state.efficiency ??= new Set();

  const suspended = process.status === "Suspended";
  const efficiencyOn = state.efficiency.has(process.pid);
  const items =
    options.items || [
      { label: "End task", icon: "power", run: () => act(state, "end") },
      { label: "Force terminate", icon: "close", danger: true, run: () => act(state, "kill") },
      { separator: true },
      {
        label: suspended ? "Resume" : "Suspend",
        icon: suspended ? "play" : "pause",
        run: () => act(state, suspended ? "resume" : "suspend"),
      },
      {
        label: efficiencyOn ? "Turn off efficiency mode" : "Efficiency mode",
        icon: "bolt",
        run: () => act(state, "efficiency"),
      },
      { label: "Priority", icon: "layers", run: () => openPriorityMenu(state) },
      { separator: true },
      {
        label: "Open file location",
        icon: "external",
        run: () => run(state, isDesktop ? api.reveal(process.pid) : mockAction("reveal", appName(process))),
      },
      { label: "Copy PID", icon: "layers", run: () => copyText(state, String(process.pid), `Copied PID ${process.pid}`) },
      {
        label: "Copy path",
        icon: "layers",
        run: () => copyText(state, process.exe || "", "Executable path copied"),
      },
      { separator: true },
      { label: "Details", icon: "activity", run: () => openDrawer(state) },
    ];

  showMenu(state, items, options.title || `${appName(process)} · PID ${process.pid}`, x, y);
}

/* ------------------------------------------------------------ detail drawer -- */

const pair = (label, value) => `<dt>${label}</dt><dd>${value}</dd>`;

async function openDrawer(state) {
  const process = selected(state);
  if (!process) return;
  const drawer = document.getElementById("drawer");
  const name = appName(process);
  state.efficiency ??= new Set();

  // Show something immediately, then fill in the command line, which needs a
  // round trip because reading another process's command line is not free.
  drawer.hidden = false;
  drawer.innerHTML = `
    <div class="drawer-head">
      <span class="tile" style="background:${fmt.tileColour(name)}">${fmt.initials(name)}</span>
      <div>
        <div class="drawer-title">${escapeHtml(name)}</div>
        <div class="drawer-sub">PID ${process.pid} · reading details…</div>
      </div>
      <button class="icon-btn" type="button" data-d="close" aria-label="Close details"><svg><use href="#i-close"/></svg></button>
    </div>`;

  let detail = null;
  try {
    detail = isDesktop ? await api.detail(process.pid) : mockDetail(process.pid);
  } catch {
    detail = null;
  }

  const suspended = process.status === "Suspended";
  const efficiencyOn = state.efficiency.has(process.pid);
  drawer.innerHTML = `
    <div class="drawer-head">
      <span class="tile" style="background:${fmt.tileColour(name)}">${fmt.initials(name)}</span>
      <div>
        <div class="drawer-title">${escapeHtml(name)}</div>
        <div class="drawer-sub">${escapeHtml(process.name)} · PID ${process.pid}</div>
      </div>
      <button class="icon-btn" type="button" data-d="close" aria-label="Close details"><svg><use href="#i-close"/></svg></button>
    </div>

    <div class="actions">
      <button class="btn is-primary" type="button" data-d="end"><svg><use href="#i-power"/></svg>End task</button>
      <button class="btn is-danger" type="button" data-d="kill">Force terminate</button>
      <button class="btn" type="button" data-d="suspend">${suspended ? "Resume" : "Suspend"}</button>
      <button class="btn" type="button" data-d="efficiency" aria-pressed="${efficiencyOn}">Efficiency mode</button>
      <button class="btn" type="button" data-d="reveal"><svg><use href="#i-external"/></svg>Open location</button>
    </div>

    <div class="section-title">Process</div>
    <dl class="kv">
      ${pair("PID", process.pid)}
      ${pair("Parent", process.ppid ?? "—")}
      ${pair("Description", escapeHtml(process.description ?? "—"))}
      ${pair("Status", `${escapeHtml(process.status)} · ${escapeHtml(process.priority ?? "—")}`)}
      ${pair("User", escapeHtml(process.user ?? "—"))}
      ${pair("Session", process.session ?? "—")}
      ${pair("Threads", process.threads ?? "—")}
      ${pair("Handles", process.handles ?? "—")}
      ${pair(
        "CPU",
        `${fmt.pct(process.cpu, 2)}% of the machine · ${fmt.pct(process.cpuPerCore, 1)}% of one core`,
      )}
      ${pair(
        "Memory",
        `${fmt.bytes(process.memory)} working set · ${fmt.bytes(process.virtualMemory)} committed`,
      )}
      ${pair("Disk", `read ${fmt.rate(process.readBps)} · write ${fmt.rate(process.writeBps)}`)}
      ${pair("GPU", process.gpu == null ? "no engine activity reported" : `${fmt.pct(process.gpu)}% engine load`)}
      ${pair("Running for", fmt.duration(process.runTimeSecs))}
      ${pair("Started", fmt.hostClock(process.startTime))}
    </dl>

    <div class="section-title">Executable</div>
    <div class="path">${escapeHtml(process.exe ?? "not available")}</div>

    <div class="section-title">Command line</div>
    <div class="path">${escapeHtml((detail?.cmd || []).join(" ") || "not available")}</div>
    ${detail?.cwd ? `<div class="section-title">Working directory</div><div class="path">${escapeHtml(detail.cwd)}</div>` : ""}
    ${detail ? `<div class="section-title">Counters</div><dl class="kv">${pair("Environment variables", detail.environmentCount)}${pair("Open files", detail.openFiles)}</dl>` : ""}`;

  const handlers = {
    close: closeDrawer,
    end: () => act(state, "end"),
    kill: () => act(state, "kill"),
    suspend: () => act(state, suspended ? "resume" : "suspend"),
    efficiency: () => act(state, "efficiency"),
    reveal: () =>
      run(state, isDesktop ? api.reveal(process.pid) : mockAction("reveal", appName(process))),
  };
  for (const [action, handler] of Object.entries(handlers)) {
    drawer.querySelector(`[data-d="${action}"]`)?.addEventListener("click", handler);
  }
  drawer.scrollTop = 0;
}

function closeDrawer() {
  const drawer = document.getElementById("drawer");
  if (drawer) drawer.hidden = true;
}






