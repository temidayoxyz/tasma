/**
 * The data views, rendered from templates.
 *
 * Every card follows the same contract: `template()` produces the markup once,
 * `mount()` grabs canvases and builds charts, and `update()` writes only the fields
 * that changed. Values are addressed by `data-f="name"` so no view needs ids that can
 * collide, and no markup is ever re-parsed on a tick.
 */

import { DotChart, drawDonut, dotBar } from "./charts.js";
import {
  bytes,
  compactPercent,
  duration,
  engineLabel,
  gb,
  heat,
  hostClock,
  initials,
  networkClass,
  pct,
  rate,
  tileColour,
} from "./format.js";
import { appName, groupApps, topBy } from "./table.js";

export const field = (root, name) => root.querySelector(`[data-f="${name}"]`);

export function setText(root, name, value) {
  const element = field(root, name);
  if (element && element.textContent !== String(value)) element.textContent = String(value);
}

export function setHtml(root, name, value) {
  const element = field(root, name);
  if (element && element.innerHTML !== value) element.innerHTML = value;
}

export function setWidth(root, name, ratio) {
  const element = field(root, name);
  if (element) element.style.width = `${Math.max(0, Math.min(100, (ratio || 0) * 100)).toFixed(2)}%`;
}

export function setChip(root, name, text, tone = "") {
  const element = field(root, name);
  if (!element) return;
  element.textContent = text;
  element.className = `chip${tone ? ` ${tone}` : ""}`;
}

export function setHeat(root, name, value) {
  const element = field(root, name);
  if (element) element.dataset.heat = heat(value);
}

export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const card = ({ icon, title, chip = "", chipName = "", span = "", body }) => `
  <section class="card ${span}">
    <div class="card-head">
      <span class="card-icon"><svg><use href="#i-${icon}"/></svg></span>
      <span class="card-title">${title}</span>
      <span class="spacer"></span>
      ${chip || chipName ? `<span class="chip" data-f="${chipName}">${chip}</span>` : ""}
    </div>
    ${body}
  </section>`;

const metric = (name, unitName, unit = "", small = false) => `
  <div class="metric">
    <span class="metric-value${small ? " is-small" : ""}" data-f="${name}">—</span>
    <span class="metric-unit"${unitName ? ` data-f="${unitName}"` : ""}>${unit}</span>
  </div>`;

const fact = (label, name) => `
  <div class="fact">
    <div class="fact-label">${label}</div>
    <div class="fact-value" data-f="${name}">—</div>
  </div>`;

const bar = (name, tone = "green") =>
  `<div class="bar tone-${tone}"><span data-f="${name}" style="width:0%"></span></div>`;

export const HEAD = (title, host) => `
  <div class="view-head">
    <span class="view-title">${title}</span>
    <span class="view-meta">
      <span class="live" data-f="live"><i class="dot"></i><span>live</span></span>
      <span data-f="host-chip">${escapeHtml(host || "")}</span>
    </span>
  </div>`;

/** One "top apps" row: tile, name, sub-line, memory, cpu. */
export const appRow = (app) => `
  <div class="row is-clickable" data-pids="${app.pids.slice(0, 12).join(",")}">
    <span class="tile" style="background:${tileColour(app.name)}">${initials(app.name)}</span>
    <span class="row-main">
      <span class="row-title">${escapeHtml(app.name)}</span>
      <span class="row-sub">${app.processes} process${app.processes === 1 ? "" : "es"}${app.hasGpu ? ` · ${pct(app.gpu)}% gpu` : ""}</span>
    </span>
    <span class="row-right" data-f="mem">${bytes(app.memory)}</span>
    <span class="row-right dim" data-f="cpu">${pct(app.cpu, 2)}%</span>
  </div>`;

/** One process row for the CPU / memory / disk / GPU leaderboards. */
export const processRow = (process, value, note = "") => `
  <div class="row is-clickable" data-pid="${process.pid}">
    <span class="tile" style="background:${tileColour(appName(process))}">${initials(appName(process))}</span>
    <span class="row-main">
      <span class="row-title">${escapeHtml(appName(process))}</span>
      <span class="row-sub">${escapeHtml(process.name)} · PID ${process.pid}</span>
    </span>
    <span class="row-right">${escapeHtml(value)}</span>
    <span class="row-right dim">${escapeHtml(note)}</span>
  </div>`;

export { card, metric, fact, bar };

/* ------------------------------------------------------------- overview --- */

export const overview = {
  id: "overview",
  title: "System overview",

  skeleton: () => `
    <div class="grid">
      ${card({
        icon: "system",
        title: "System",
        chip: "this pc",
        body: `
          ${metric("uptime", "uptime-unit", "up", true)}
          <div class="facts">
            ${fact("Logical cores", "cores")}
            ${fact("Installed memory", "total-mem")}
            ${fact("Operating system", "os")}
            ${fact("Booted", "booted")}
          </div>`,
      })}
      ${card({
        icon: "cpu",
        title: "CPU",
        chipName: "cpu-chip",
        body: `
          ${metric("cpu-usage", "cpu-unit", "%")}
          <canvas class="chart" data-c="cpu" aria-hidden="true"></canvas>
          <div class="facts">
            ${fact("Busiest process", "cpu-top")}
            ${fact("Load average", "cpu-load")}
          </div>`,
      })}
      ${card({
        icon: "gpu",
        title: "GPU",
        chipName: "gpu-chip",
        body: `
          ${metric("gpu-usage", "gpu-unit", "%")}
          <canvas class="chart" data-c="gpu" aria-hidden="true"></canvas>
          <div class="facts">
            ${fact("Adapter", "gpu-name")}
            ${fact("Video memory", "gpu-vram")}
          </div>`,
      })}
      ${card({
        icon: "memory",
        title: "Memory",
        chipName: "mem-chip",
        body: `
          ${metric("mem-used", "mem-unit", "GB in use")}
          <div class="dotbar tone-violet" data-f="mem-dots"></div>
          <div class="facts">
            ${fact("Available", "mem-available")}
            ${fact("Pagefile in use", "mem-swap")}
          </div>`,
      })}
      ${card({
        icon: "disk",
        title: "Disk",
        chipName: "disk-chip",
        body: `
          ${metric("disk-free", "disk-unit", "GB free", true)}
          ${bar("disk-bar", "amber")}
          <div class="facts">
            ${fact("Used of capacity", "disk-used")}
            ${fact("Throughput", "disk-io")}
          </div>`,
      })}
      ${card({
        icon: "network",
        title: "Network",
        chipName: "net-chip",
        body: `
          ${metric("net-down", "net-unit", "down", true)}
          <canvas class="chart" data-c="net" aria-hidden="true"></canvas>
          <div class="facts">
            ${fact("Downloaded", "net-received")}
            ${fact("Uploaded", "net-sent")}
          </div>`,
      })}
      ${card({
        icon: "layers",
        title: "Memory balance",
        body: `
          <div class="donut-wrap">
            <canvas data-c="donut" aria-hidden="true"></canvas>
            <div class="donut-centre">
              <div class="donut-value" data-f="donut-value">—</div>
              <div class="donut-label">in use</div>
            </div>
          </div>
          <div class="legend">
            <span><i class="swatch-violet"></i>used</span>
            <span><i class="swatch-muted"></i>available</span>
            <span><i class="swatch-amber"></i>pagefile</span>
          </div>`,
      })}
      ${card({
        icon: "activity",
        title: "Top apps",
        span: "span-2",
        chipName: "apps-chip",
        chip: "by memory",
        body: `
          <div class="rows rows-head" aria-hidden="true">
            <span></span><span class="row-main">App</span>
            <span class="row-right">Memory</span><span class="row-right dim">CPU</span>
          </div>
          <div class="rows" data-f="top-apps"></div>`,
      })}
    </div>
    <p class="note">CPU is a share of the whole machine — the same figure the Windows Task Manager reports.</p>`,

  mount(root) {
    return {
      cpu: new DotChart(root.querySelector('canvas[data-c="cpu"]'), { tone: "green", rows: 7 }),
      gpu: new DotChart(root.querySelector('canvas[data-c="gpu"]'), { tone: "violet", rows: 7 }),
      net: new DotChart(root.querySelector('canvas[data-c="net"]'), { tone: "blue", rows: 7 }),
      donut: root.querySelector('canvas[data-c="donut"]'),
      memory: root.querySelector('[data-f="mem-dots"]'),
      netCeiling: 512 * 1024,
    };
  },

  update(root, snapshot, state) {
    const { host, cpu, memory, disks, networks, gpus, processes } = snapshot;

    setText(root, "host-chip", `${host.name} · ${host.os}`);
    setText(root, "uptime", duration(host.uptimeSecs));
    setText(root, "cores", `${host.physicalCores ?? "?"} physical · ${host.logicalCores} logical`);
    setText(root, "total-mem", `${gb(host.totalMemory)} GB`);
    setText(root, "os", `${host.os} ${host.kernel}`);
    setText(root, "booted", hostClock(host.bootTime));

    setChip(root, "cpu-chip", `${cpu.logical} cores · ${(cpu.frequencyMhz / 1000).toFixed(2)} GHz`);
    setText(root, "cpu-usage", compactPercent(cpu.usage));
    setHeat(root, "cpu-usage", cpu.usage);
    setText(root, "cpu-top", cpu.topProcess || "idle");
    setText(root, "cpu-load", (cpu.loadAvg || []).map((value) => value.toFixed(2)).join("  "));
    state.cpu.push(cpu.usage);

    const gpu = (gpus || [])[0];
    if (gpu) {
      setText(root, "gpu-usage", gpu.usage == null ? "—" : compactPercent(gpu.usage));
      setHeat(root, "gpu-usage", gpu.usage ?? 0);
      setChip(
        root,
        "gpu-chip",
        gpu.usage == null ? "no counters" : engineLabel(gpu.usageEngine),
        gpu.usage == null ? "is-quiet" : "",
      );
      setText(root, "gpu-name", gpu.name);
      setText(root, "gpu-vram", `${gb(gpu.vram)} GB dedicated`);
      state.gpu.push(gpu.usage ?? 0);
    } else {
      setText(root, "gpu-usage", "—");
      setChip(root, "gpu-chip", "not detected", "is-quiet");
      setText(root, "gpu-name", "no adapter reported");
      setText(root, "gpu-vram", "—");
      state.gpu.push(0);
    }

    const usedRatio = memory.usedPct / 100;
    setText(root, "mem-used", gb(memory.used));
    setText(root, "mem-unit", `GB of ${gb(memory.total, 0)} GB`);
    setChip(
      root,
      "mem-chip",
      memory.usedPct >= 90 ? "critical" : memory.usedPct >= 80 ? "tight" : "normal",
      memory.usedPct >= 90 ? "is-hot" : memory.usedPct >= 80 ? "is-warn" : "is-good",
    );
    setText(root, "mem-available", `${gb(memory.available)} GB available`);
    setText(root, "mem-swap", `${gb(memory.usedSwap)} GB of ${gb(memory.totalSwap, 0)} GB`);
    dotBar(state.memory, usedRatio, 26);
    drawDonut(state.donut, usedRatio, { tone: "violet" });
    setText(root, "donut-value", `${compactPercent(memory.usedPct)}%`);

    const disk = (disks || []).find((volume) => volume.system) || (disks || [])[0];
    if (disk) {
      setText(root, "disk-free", gb(disk.available, 0));
      setText(root, "disk-unit", `GB free on ${disk.mountPoint}`);
      setChip(
        root,
        "disk-chip",
        `${pct(disk.usedPct, 0)}% used`,
        disk.usedPct >= 92 ? "is-hot" : disk.usedPct >= 80 ? "is-warn" : "is-good",
      );
      setWidth(root, "disk-bar", disk.usedPct / 100);
      setText(root, "disk-used", `${gb(disk.used, 0)} of ${gb(disk.total, 0)} GB · ${disk.kind}`);
      setText(root, "disk-io", `r ${rate(disk.readBps)}  w ${rate(disk.writeBps)}`);
    }

    const net = (networks || [])[0];
    if (net) {
      setText(root, "net-down", rate(net.receivedBps));
      setText(root, "net-unit", "down now");
      setChip(
        root,
        "net-chip",
        `up ${rate(net.transmittedBps)}`,
        networkClass(net.receivedBps + net.transmittedBps),
      );
      setText(root, "net-received", `${bytes(net.totalReceived)} · ${net.name}`);
      setText(root, "net-sent", bytes(net.totalTransmitted));
      // A decaying ceiling keeps small traffic readable without clipping big spikes.
      const peak = Math.max(net.receivedBps, net.transmittedBps, 64 * 1024);
      state.netCeiling = Math.max(peak, state.netCeiling * 0.92);
      state.net.max = state.netCeiling;
      state.net.push(net.receivedBps + net.transmittedBps);
    }

    setChip(root, "apps-chip", `${snapshot.counts.apps} apps`);
    setHtml(root, "top-apps", groupApps(processes, { limit: 5, by: "memory" }).map(appRow).join(""));
  },
};

/* -------------------------------------------------------- cpu and gpu ----- */

export const cpuView = {
  id: "cpu",
  title: "CPU & GPU",

  skeleton: () => `
    <div class="grid">
      ${card({
        icon: "cpu",
        title: "Processor",
        span: "span-2",
        chipName: "cpu-chip",
        body: `
          ${metric("cpu-usage", "cpu-unit", "%")}
          <canvas class="chart tall" data-c="cpu" aria-hidden="true"></canvas>
          <div class="cores" data-f="cores"></div>`,
      })}
      ${card({
        icon: "gpu",
        title: "Graphics",
        chipName: "gpu-chip",
        body: `
          ${metric("gpu-usage", "gpu-unit", "%")}
          <canvas class="chart tall" data-c="gpu" aria-hidden="true"></canvas>
          <div class="facts">
            ${fact("Adapter", "gpu-name")}
            ${fact("Video memory", "gpu-vram")}
          </div>`,
      })}
      ${card({
        icon: "activity",
        title: "Top by CPU",
        span: "span-2",
        chipName: "top-chip",
        body: `<div class="rows" data-f="top-cpu"></div>`,
      })}
      ${card({
        icon: "gpu",
        title: "Top by GPU",
        body: `<div class="rows" data-f="top-gpu"></div>`,
      })}
    </div>
    <p class="note">Per-core figures are a share of each logical processor. Per-process GPU load is summed across engines from the same Windows performance counters the Task Manager reads.</p>`,

  mount(root) {
    return {
      cpu: new DotChart(root.querySelector('canvas[data-c="cpu"]'), { tone: "green", rows: 9, samples: 90 }),
      gpu: new DotChart(root.querySelector('canvas[data-c="gpu"]'), { tone: "violet", rows: 9, samples: 90 }),
      cores: root.querySelector('[data-f="cores"]'),
      coreCount: 0,
    };
  },

  update(root, snapshot, state) {
    const { cpu, gpus, processes } = snapshot;

    setChip(
      root,
      "cpu-chip",
      `${cpu.brand || "unknown"} · ${(cpu.frequencyMhz / 1000).toFixed(2)} GHz`,
    );
    setText(root, "cpu-usage", compactPercent(cpu.usage));
    setHeat(root, "cpu-usage", cpu.usage);
    state.cpu.push(cpu.usage);

    // Rebuild the core grid only when the processor count changes.
    const cores = cpu.perCore || [];
    if (state.coreCount !== cores.length) {
      state.coreCount = cores.length;
      state.cores.innerHTML = cores
        .map(
          (_, index) => `
          <div class="core">
            <span class="core-label">CPU ${index}</span>
            <span class="core-track"><span></span></span>
            <span class="core-value">—</span>
          </div>`,
        )
        .join('');
    }
    const rows = state.cores.children;
    cores.forEach((value, index) => {
      const row = rows[index];
      if (!row) return;
      const track = row.querySelector('.core-track > span');
      track.style.width = `${pct(value)}%`;
      track.dataset.heat = heat(value);
      row.querySelector('.core-value').textContent = `${pct(value, 0)}%`;
    });

    const gpu = (gpus || [])[0];
    setText(root, "gpu-usage", gpu?.usage == null ? "—" : compactPercent(gpu.usage));
    setHeat(root, "gpu-usage", gpu?.usage ?? 0);
    setChip(
      root,
      "gpu-chip",
      gpu ? (gpu.usage == null ? "no counters" : engineLabel(gpu.usageEngine)) : "not detected",
      gpu?.usage == null ? "is-quiet" : "",
    );
    setText(root, "gpu-name", gpu ? gpu.name : "no adapter reported");
    setText(root, "gpu-vram", gpu ? `${gb(gpu.vram)} GB dedicated` : "—");
    state.gpu.push(gpu?.usage ?? 0);

    setChip(root, "top-chip", `${processes.length} processes`);
    setHtml(
      root,
      "top-cpu",
      topBy(processes, "cpu", 6)
        .map((process) => processRow(process, `${pct(process.cpu, 2)}%`, bytes(process.memory)))
        .join("") || `<p class="note">Nothing is using the CPU.</p>`,
    );
    setHtml(
      root,
      "top-gpu",
      topBy(processes, "gpu", 5)
        .map((process) => processRow(process, `${pct(process.gpu)}%`, bytes(process.memory)))
        .join("") || `<p class="note">No process is using a GPU engine right now.</p>`,
    );
  },
};

/* ---------------------------------------------------------------- memory -- */

export const memoryView = {
  id: "memory",
  title: "Memory",

  skeleton: () => `
    <div class="grid">
      ${card({
        icon: "memory",
        title: "Physical memory",
        chipName: "mem-chip",
        body: `
          <div class="donut-wrap">
            <canvas data-c="donut" aria-hidden="true"></canvas>
            <div class="donut-centre">
              <div class="donut-value" data-f="donut-value">—</div>
              <div class="donut-label">in use</div>
            </div>
          </div>
          <div class="dotbar tone-violet" data-f="mem-dots"></div>
          <div class="facts">
            ${fact("Total", "mem-total")}
            ${fact("In use", "mem-used")}
            ${fact("Available", "mem-available")}
            ${fact("Free", "mem-free")}
          </div>`,
      })}
      ${card({
        icon: "activity",
        title: "History",
        span: "span-2",
        chipName: "hist-chip",
        body: `
          ${metric("mem-pct", "mem-pct-unit", "% in use", true)}
          <canvas class="chart tall" data-c="mem" aria-hidden="true"></canvas>
          <div class="legend">
            <span><i class="swatch-violet"></i>physical in use</span>
            <span><i class="swatch-amber"></i>pagefile</span>
          </div>`,
      })}
      ${card({
        icon: "layers",
        title: "Pagefile and working sets",
        body: `
          <div class="facts cols-1">
            ${fact("Pagefile in use", "swap-used")}
            ${fact("Resident across processes", "resident")}
          </div>`,
      })}
      ${card({
        icon: "activity",
        title: "Top by memory",
        span: "span-2",
        chipName: "top-chip",
        body: `<div class="rows" data-f="top-mem"></div>`,
      })}
    </div>
    <p class="note">This is physical RAM in use, not commit charge. "Resident across processes" is the sum of every working set, so shared pages (DLLs, the font cache) are counted once per process and it will read higher than the total.</p>`,

  mount(root) {
    return {
      mem: new DotChart(root.querySelector('canvas[data-c="mem"]'), { tone: "violet", rows: 9, samples: 90 }),
      donut: root.querySelector('canvas[data-c="donut"]'),
      memory: root.querySelector('[data-f="mem-dots"]'),
    };
  },

  update(root, snapshot, state) {
    const { memory, processes, counts } = snapshot;
    const usedRatio = memory.usedPct / 100;

    setChip(
      root,
      "mem-chip",
      memory.usedPct >= 90 ? "critical" : memory.usedPct >= 80 ? "tight" : "normal",
      memory.usedPct >= 90 ? "is-hot" : memory.usedPct >= 80 ? "is-warn" : "is-good",
    );
    setText(root, "donut-value", `${compactPercent(memory.usedPct)}%`);
    dotBar(state.memory, usedRatio, 30);
    drawDonut(state.donut, usedRatio, { tone: "violet" });

    setText(root, "mem-total", `${gb(memory.total)} GB`);
    setText(root, "mem-used", `${gb(memory.used)} GB`);
    setText(root, "mem-available", `${gb(memory.available)} GB`);
    setText(root, "mem-free", `${gb(memory.free)} GB`);

    setText(root, "mem-pct", compactPercent(memory.usedPct));
    setChip(root, "hist-chip", `${state.mem.values.length} samples`);
    state.mem.push(memory.usedPct);

    setText(
      root,
      "swap-used",
      `${gb(memory.usedSwap)} GB of ${gb(memory.totalSwap, 0)} GB`,
    );
    const resident = processes.reduce((total, process) => total + (process.memory || 0), 0);
    setText(root, "resident", `${gb(resident)} GB across ${counts.processes} processes`);

    setChip(root, "top-chip", `${counts.apps} apps`);
    setHtml(
      root,
      "top-mem",
      topBy(processes, "memory", 8)
        .map((process) => processRow(process, bytes(process.memory), `${pct(process.cpu, 2)}% cpu`))
        .join("") || `<p class="note">No processes reported.</p>`,
    );
  },
};

/* --------------------------------------------------------------- network -- */

export const networkView = {
  id: "network",
  title: "Network",

  skeleton: () => `
    <div class="grid">
      ${card({
        icon: "network",
        title: "Throughput",
        span: "span-2",
        chipName: "net-chip",
        body: `
          <div class="facts">
            ${fact("Downloading", "net-down")}
            ${fact("Uploading", "net-up")}
          </div>
          <canvas class="chart tall" data-c="net" aria-hidden="true"></canvas>`,
      })}
      ${card({
        icon: "layers",
        title: "This session",
        body: `
          <div class="facts cols-1">
            ${fact("Downloaded", "net-received")}
            ${fact("Uploaded", "net-sent")}
            ${fact("Packets in / out", "net-packets")}
          </div>`,
      })}
      <div class="grid cols-2 span-3" data-f="adapters"></div>
    </div>
    <p class="note">Windows has no public per-process network counter — the Task Manager gets its numbers from an internal driver. Tasma shows adapter-level throughput, which is what the counters can honestly provide.</p>`,

  mount(root) {
    return {
      net: new DotChart(root.querySelector('canvas[data-c="net"]'), { tone: "blue", rows: 9, samples: 90 }),
      adapters: root.querySelector('[data-f="adapters"]'),
      ceiling: 512 * 1024,
    };
  },

  update(root, snapshot, state) {
    const networks = snapshot.networks || [];
    const active = networks[0];
    const received = networks.reduce((total, item) => total + item.receivedBps, 0);
    const sent = networks.reduce((total, item) => total + item.transmittedBps, 0);

    setChip(root, "net-chip", networks.length ? `${networks.length} adapters` : "no adapter");
    setText(root, "net-down", rate(received));
    setText(root, "net-up", rate(sent));
    setText(root, "net-received", bytes(networks.reduce((total, item) => total + item.totalReceived, 0)));
    setText(root, "net-sent", bytes(networks.reduce((total, item) => total + item.totalTransmitted, 0)));
    setText(
      root,
      "net-packets",
      `${networks.reduce((total, item) => total + item.packetsIn, 0).toLocaleString()} in`,
    );

    // Same decaying ceiling as the overview, so a quiet link stays readable.
    const peak = Math.max(received, sent, active?.receivedBps ?? 0, 64 * 1024);
    state.ceiling = Math.max(peak, state.ceiling * 0.92);
    state.net.max = state.ceiling;
    state.net.push(received + sent);

    setHtml(
      root,
      "adapters",
      networks
        .map(
          (item) => `
      ${card({
        icon: "network",
        title: escapeHtml(item.name),
        chip: item.ipv4[0] ? escapeHtml(item.ipv4[0].split("/")[0]) : "no address",
        body: `
          <div class="facts">
            ${fact("Downloading", `a-${item.name}-down`)}
            ${fact("Uploading", `a-${item.name}-up`)}
            ${fact("Downloaded", `a-${item.name}-received`)}
            ${fact("Uploaded", `a-${item.name}-sent`)}
          </div>
          <p class="note">${escapeHtml(item.mac)}</p>`,
      })}`,
        )
        .join(""),
    );

    // Adapter cards are rebuilt above, so their fields are written straight after.
    for (const item of networks) {
      const scope = root.querySelector(`[data-f="a-${item.name}-down"]`);
      if (!scope) continue;
      scope.textContent = rate(item.receivedBps);
      root.querySelector(`[data-f="a-${item.name}-up"]`).textContent = rate(item.transmittedBps);
      root.querySelector(`[data-f="a-${item.name}-received"]`).textContent = bytes(item.totalReceived);
      root.querySelector(`[data-f="a-${item.name}-sent"]`).textContent = bytes(item.totalTransmitted);
    }
  },
};

/* ------------------------------------------------------------------ disk -- */

const volumeCard = (volume, index) => `
  ${card({
    icon: "disk",
    title: escapeHtml(volume.mountPoint),
    chip: `${volume.kind} · ${volume.fileSystem}`,
    body: `
      ${metric(`v${index}-free`, `v${index}-unit`, "GB free", true)}
      ${bar(`v${index}-bar`, volume.usedPct >= 90 ? "red" : "amber")}
      <div class="facts">
        ${fact("Used of capacity", `v${index}-used`)}
        ${fact("Throughput", `v${index}-io`)}
      </div>
      <canvas class="chart" data-c="${`io-${index}`}" aria-hidden="true"></canvas>
      <p class="note">${escapeHtml(volume.name)}${volume.removable ? " · removable" : ""}</p>`,
  })}`;

export const diskView = {
  id: "disk",
  title: "Disk",

  skeleton: () => `
    <div class="grid">
      <div class="grid cols-2 span-3" data-f="volumes"></div>
      ${card({
        icon: "activity",
        title: "Top by disk I/O",
        span: "span-3",
        chipName: "io-chip",
        body: `<div class="rows" data-f="top-io"></div>`,
      })}
    </div>
    <p class="note">On Windows a process's I/O counters cover every handle it owns, not only files on disk, so a busy network or pipe user can appear here too — the Task Manager's Disk column has the same caveat.</p>`,

  mount(root) {
    return {
      volumes: root.querySelector('[data-f="volumes"]'),
      charts: new Map(),
      ceilings: new Map(),
      layout: "",
    };
  },

  update(root, snapshot, state) {
    const volumes = snapshot.disks || [];

    // Rebuild only when the set of volumes changes, so the canvases survive ticks.
    const layout = volumes.map((volume) => `${volume.mountPoint}:${volume.kind}`).join("|");
    if (state.layout !== layout) {
      state.layout = layout;
      state.volumes.innerHTML = volumes.map(volumeCard).join("");
      state.charts.clear();
      state.ceilings.clear();
    }

    volumes.forEach((volume, index) => {
      setText(root, `v${index}-free`, gb(volume.available, 0));
      setText(root, `v${index}-unit`, `GB free of ${gb(volume.total, 0)} GB`);
      setWidth(root, `v${index}-bar`, volume.usedPct / 100);
      setText(
        root,
        `v${index}-used`,
        `${gb(volume.used, 0)} GB used · ${pct(volume.usedPct, 0)}%`,
      );
      setText(
        root,
        `v${index}-io`,
        `r ${rate(volume.readBps)}  w ${rate(volume.writeBps)}`,
      );

      let chart = state.charts.get(index);
      if (!chart) {
        const canvas = root.querySelector(`canvas[data-c="io-${index}"]`);
        if (canvas) {
          chart = new DotChart(canvas, { tone: "amber", rows: 6, samples: 90 });
          state.charts.set(index, chart);
          state.ceilings.set(index, 8 * 1024 * 1024);
        }
      }
      if (chart) {
        const total = volume.readBps + volume.writeBps;
        const ceiling = Math.max(total, (state.ceilings.get(index) || 0) * 0.94, 256 * 1024);
        state.ceilings.set(index, ceiling);
        chart.max = ceiling;
        chart.push(total);
      }
    });

    const busiest = [...(snapshot.processes || [])]
      .map((process) => ({ process, io: (process.readBps || 0) + (process.writeBps || 0) }))
      .filter((entry) => entry.io > 0)
      .sort((left, right) => right.io - left.io)
      .slice(0, 7);

    setChip(root, "io-chip", `${volumes.length} volumes`);
    setHtml(
      root,
      "top-io",
      busiest
        .map(({ process, io }) =>
          processRow(
            process,
            `${rate(io)}`,
            `r ${rate(process.readBps)} · w ${rate(process.writeBps)}`,
          ),
        )
        .join("") || `<p class="note">Nothing is touching the disk right now.</p>`,
    );
  },
};

/** Views that render from a snapshot. The Processes tab supplies its own. */
export const DATA_VIEWS = {
  overview,
  cpu: cpuView,
  memory: memoryView,
  network: networkView,
  disk: diskView,
};
