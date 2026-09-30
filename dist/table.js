/**
 * Process table logic: filtering, sorting and the virtual window maths.
 *
 * Kept apart from `processes.js` (which owns the DOM) so it can be unit tested in
 * Node. The list has to survive 500+ rows re-sorting every second without flicker,
 * so sorting is a pure function of (list, key, direction) and never mutates input.
 */

export const ROW_HEIGHT = 34;
export const OVERSCAN = 6;

export const COLUMNS = [
  { key: "name", label: "App", align: "left" },
  { key: "pid", label: "PID", align: "right" },
  { key: "cpu", label: "CPU", align: "right" },
  { key: "memory", label: "Memory", align: "right" },
  { key: "disk", label: "Disk", align: "right" },
  { key: "gpu", label: "GPU", align: "right" },
  { key: "threads", label: "Threads", align: "right" },
  { key: "status", label: "Status", align: "right" },
];

export function appName(process) {
  return process.description || process.name || `PID ${process.pid}`;
}

/**
 * Case-insensitive match across the friendly name, the executable, the PID and the
 * user, because people search for all four and should not have to pick a field.
 */
export function matches(process, query) {
  if (!query) return true;
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    appName(process).toLowerCase().includes(needle) ||
    (process.name || "").toLowerCase().includes(needle) ||
    (process.exe || "").toLowerCase().includes(needle) ||
    (process.user || "").toLowerCase().includes(needle) ||
    (process.priority || "").toLowerCase().includes(needle) ||
    String(process.pid) === needle
  );
}

export function filterProcesses(processes, query, { hideSystem = false, minCpu = 0, onlyGpu = false } = {}) {
  return (processes || []).filter((process) => {
    if (!matches(process, query)) return false;
    if (hideSystem && process.pid <= 4) return false;
    if (minCpu > 0 && (process.cpu || 0) < minCpu) return false;
    if (onlyGpu && !(process.gpu > 0)) return false;
    return true;
  });
}

const STRING_KEYS = new Set(["name", "status", "user", "priority"]);

function valueOf(process, key, cpuScale) {
  switch (key) {
    case "name":
      return appName(process).toLowerCase();
    case "disk":
      return (process.readBps || 0) + (process.writeBps || 0);
    case "gpu":
      return process.gpu ?? -1;
    case "cpu":
      return cpuScale === "perCore" ? process.cpuPerCore ?? 0 : process.cpu ?? 0;
    default:
      return process[key] ?? 0;
  }
}

/**
 * Sorts a copy of the list. Ties always fall back to the pid so equal values never
 * swap places between ticks - that is what stops the table from shivering.
 */
export function sortProcesses(processes, key = "cpu", direction = "desc", cpuScale = "total") {
  const factor = direction === "asc" ? 1 : -1;
  const list = [...(processes || [])];
  list.sort((left, right) => {
    const a = valueOf(left, key, cpuScale);
    const b = valueOf(right, key, cpuScale);
    let result = 0;
    if (STRING_KEYS.has(key) || typeof a === "string" || typeof b === "string") {
      result = String(a).localeCompare(String(b));
    } else {
      result = a - b;
    }
    if (result !== 0) return result * factor;
    return left.pid - right.pid;
  });
  return list;
}

/** The slice of rows worth rendering for a scroll position. */
export function virtualWindow({ scrollTop, viewportHeight, total, rowHeight = ROW_HEIGHT, overscan = OVERSCAN }) {
  const visible = Math.max(1, Math.ceil(viewportHeight / rowHeight));
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(total, start + visible + overscan * 2);
  return { start, end, height: total * rowHeight, count: Math.max(0, end - start) };
}

/** Summary line for the toolbar: "412 processes · 129 apps · 8.4 GB resident". */
export function summarise(processes, intervalMs) {
  const list = processes || [];
  const apps = new Set(list.map((process) => appName(process).toLowerCase()));
  const resident = list.reduce((total, process) => total + (process.memory || 0), 0);
  const busiest = list.reduce((top, process) => (process.cpu > (top?.cpu ?? -1) ? process : top), null);
  return {
    processes: list.length,
    apps: apps.size,
    resident,
    intervalMs,
    busiest: busiest && busiest.cpu > 1 ? appName(busiest) : null,
  };
}

/**
 * Collapses the process list into apps, the way the Task Manager's Processes tab
 * does: every chrome.exe becomes one "Google Chrome" row with the totals of its
 * children. Sorted by the requested metric, ties broken by name so rows hold still.
 */
export function groupApps(processes, { limit = 6, by = "memory" } = {}) {
  const groups = new Map();
  for (const process of processes || []) {
    const key = appName(process).toLowerCase();
    const entry = groups.get(key) || {
      key,
      name: appName(process),
      exe: process.name,
      processes: 0,
      cpu: 0,
      memory: 0,
      threads: 0,
      handles: 0,
      gpu: 0,
      hasGpu: false,
      pids: [],
      user: process.user,
    };
    entry.processes += 1;
    entry.cpu += process.cpu || 0;
    entry.memory += process.memory || 0;
    entry.threads += process.threads || 0;
    entry.handles += process.handles || 0;
    if (process.gpu != null) {
      entry.gpu += process.gpu;
      entry.hasGpu = true;
    }
    entry.pids.push(process.pid);
    groups.set(key, entry);
  }

  const list = [...groups.values()];
  list.sort((left, right) => {
    const difference = (right[by] || 0) - (left[by] || 0);
    return difference !== 0 ? difference : left.name.localeCompare(right.name);
  });
  return limit > 0 ? list.slice(0, limit) : list;
}

/** Top n processes by one numeric key. */
export function topBy(processes, key, limit = 5) {
  return [...(processes || [])]
    .filter((process) => (process[key] || 0) > 0)
    .sort((left, right) => {
      const difference = (right[key] || 0) - (left[key] || 0);
      return difference !== 0 ? difference : left.pid - right.pid;
    })
    .slice(0, limit);
}
