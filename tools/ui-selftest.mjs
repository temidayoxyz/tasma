/**
 * Node self-test for the UI's logic.
 *
 * The dashboard is plain ES modules with no build step, so the pure parts can be
 * exercised without a browser. Run it with `node tools/ui-selftest.mjs`.
 *
 * The most valuable test in here is the contract check: it asserts every field the UI
 * reads exists on a snapshot, using the names Rust's serde `rename_all =
 * "camelCase"` produces. Rename a field in Rust and this fails, instead of a panel
 * quietly showing an em dash forever.
 */

import assert from "node:assert/strict";

import {
  bytes,
  compactPercent,
  duration,
  engineLabel,
  gb,
  heat,
  initials,
  networkClass,
  pct,
  rate,
  tileColour,
} from "../dist/format.js";
import {
  COLUMNS,
  ROW_HEIGHT,
  filterProcesses,
  groupApps,
  matches,
  sortProcesses,
  summarise,
  topBy,
  virtualWindow,
} from "../dist/table.js";
import { mockDetail, mockReset, mockSnapshot } from "../dist/api.js";

const tests = [];
const test = (name, run) => tests.push({ name, run });

/* ---------------------------------------------------------------- format -- */

test("byte sizes step through units", () => {
  assert.equal(bytes(0), "0 B");
  assert.equal(bytes(999), "999 B");
  assert.equal(bytes(1024), "1.0 KB");
  assert.equal(bytes(1024 * 1024 * 1024), "1.0 GB");
  assert.equal(gb(1024 ** 3 * 64), "64.0");
});

test("rates carry a per second suffix", () => {
  assert.equal(rate(0), "0 B/s");
  assert.equal(rate(1024), "1.0 KB/s");
});

test("percentages are clamped rather than trusted", () => {
  assert.equal(pct(140), "100.0");
  assert.equal(pct(-3), "0.0");
  assert.equal(pct(Number.NaN), "0");
  assert.equal(compactPercent(100), "100");
});

test("durations read like a monitor", () => {
  assert.equal(duration(45), "45s");
  assert.equal(duration(3 * 3600 + 41 * 60 + 9), "3h 41m");
  assert.equal(duration(2 * 86400 + 3600), "2d 1h");
  assert.equal(duration(undefined), "0s");
});

test("initials come from the friendly name first", () => {
  assert.equal(initials("Google Chrome"), "GC");
  assert.equal(initials("chrome.exe"), "CH");
  assert.equal(initials(""), "?");
});

test("colours, heat and labels stay deterministic", () => {
  assert.equal(tileColour("Google Chrome"), tileColour("google chrome"));
  assert.equal(heat(80), "hot");
  assert.equal(heat(40), "warm");
  assert.equal(heat(3), "cool");
  assert.equal(engineLabel("VideoDecode"), "Video Decode");
  assert.equal(networkClass(2048), "is-good");
});

/* ----------------------------------------------------------------- table -- */

const sample = [
  { pid: 3, name: "b.exe", description: null, cpu: 5, memory: 10, cpuPerCore: 20 },
  { pid: 1, name: "a.exe", description: null, cpu: 5, memory: 10, cpuPerCore: 30 },
  { pid: 2, name: "c.exe", description: null, cpu: 9, memory: 1, cpuPerCore: 90 },
];

test("sorting is stable and never mutates the input", () => {
  const before = JSON.stringify(sample);
  assert.deepEqual(
    sortProcesses(sample, "cpu", "desc").map((process) => process.pid),
    [2, 1, 3],
    "equal cpu falls back to the pid, so rows hold still between ticks",
  );
  assert.deepEqual(
    sortProcesses(sample, "name", "asc").map((process) => process.name),
    ["a.exe", "b.exe", "c.exe"],
  );
  assert.deepEqual(sortProcesses(sample, "memory", "asc").map((process) => process.pid), [2, 1, 3]);
  assert.equal(JSON.stringify(sample), before);
});

test("the cpu scale toggle switches which number is read", () => {
  const list = [{ pid: 1, cpu: 10, cpuPerCore: 300 }];
  assert.equal(sortProcesses(list, "cpu", "desc", "total")[0].cpu, 10);
  assert.equal(sortProcesses(list, "cpu", "desc", "perCore")[0].cpuPerCore, 300);
});

test("filtering searches every field a person would try", () => {
  const list = [
    {
      pid: 10,
      name: "chrome.exe",
      description: "Google Chrome",
      exe: "C:\\chrome.exe",
      user: "Tasma",
      priority: "Normal",
    },
    {
      pid: 4242,
      name: "svchost.exe",
      description: null,
      exe: "C:\\Windows\\System32\\svchost.exe",
      user: "SYSTEM",
      priority: "High",
    },
  ];
  assert.ok(matches(list[0], "google"));
  assert.ok(matches(list[1], "4242"), "a bare pid matches");
  assert.ok(matches(list[1], "system32"));
  assert.ok(matches(list[1], "high"));
  assert.ok(!matches(list[0], "firefox"));
  assert.equal(filterProcesses(list, "chrome").length, 1);
  assert.equal(filterProcesses(list, "").length, 2);
  assert.equal(filterProcesses(list, "   ").length, 2);
});

test("filters for kernel rows, a cpu floor and gpu only", () => {
  const list = [
    { pid: 4, name: "System", description: "System", cpu: 0, memory: 0, gpu: null },
    { pid: 8, name: "quiet.exe", description: null, cpu: 0.2, memory: 1, gpu: null },
    { pid: 9, name: "hot.exe", description: null, cpu: 30, memory: 1, gpu: 12 },
  ];
  assert.equal(filterProcesses(list, "", { hideSystem: true }).length, 2);
  assert.equal(filterProcesses(list, "", { minCpu: 1 }).length, 1);
  assert.equal(filterProcesses(list, "", { onlyGpu: true }).length, 1);
});

test("the virtual window only ever covers the viewport", () => {
  const total = 500;
  const slice = virtualWindow({ scrollTop: 0, viewportHeight: 400, total });
  assert.equal(slice.start, 0);
  assert.ok(slice.count <= Math.ceil(400 / ROW_HEIGHT) + 12, "the pool stays viewport sized");
  assert.equal(slice.height, total * ROW_HEIGHT);

  const scrolled = virtualWindow({ scrollTop: 3000, viewportHeight: 400, total });
  assert.ok(scrolled.start > 0);
  assert.ok(scrolled.end <= total, "never slices past the end");
});

test("apps are grouped the way the task manager groups them", () => {
  const list = [
    { pid: 1, name: "chrome.exe", description: "Google Chrome", memory: 100, cpu: 1, gpu: null, threads: 2, handles: 3 },
    { pid: 2, name: "chrome.exe", description: "Google Chrome", memory: 250, cpu: 2, gpu: 5, threads: 4, handles: 6 },
    { pid: 3, name: "Code.exe", description: "Visual Studio Code", memory: 900, cpu: 8, gpu: 3, threads: 9, handles: 1 },
  ];
  const apps = groupApps(list, { by: "memory" });
  assert.equal(apps.length, 2, "two apps, three processes");
  assert.equal(apps[0].name, "Visual Studio Code");
  const chrome = apps.find((app) => app.name === "Google Chrome");
  assert.equal(chrome.memory, 350);
  assert.equal(chrome.processes, 2);
  assert.equal(chrome.gpu, 5);
  assert.ok(chrome.hasGpu);
  assert.equal(topBy(list, "cpu", 1).length, 1);
});

test("summaries count processes, apps and resident bytes", () => {
  const list = [
    { pid: 1, name: "a.exe", description: "A", memory: 1024, cpu: 12 },
    { pid: 2, name: "b.exe", description: "B", memory: 2048, cpu: 0 },
    { pid: 3, name: "a.exe", description: "A", memory: 1024, cpu: 0 },
  ];
  const summary = summarise(list, 1000);
  assert.equal(summary.processes, 3);
  assert.equal(summary.apps, 2);
  assert.equal(summary.resident, 4096);
  assert.equal(summary.busiest, "A");
});

test("table columns are unique and backed by the snapshot", () => {
  const keys = COLUMNS.map((column) => column.key);
  assert.equal(new Set(keys).size, keys.length, "no duplicate column keys");
  assert.ok(COLUMNS.every((column) => ["left", "right"].includes(column.align)));
  const process = mockSnapshot().processes[0];
  for (const column of COLUMNS) {
    if (["name", "disk", "status"].includes(column.key)) continue;
    assert.ok(column.key in process, `column "${column.key}" is not in a snapshot process`);
  }
});

/* ------------------------------------------------------- backend contract -- */

test("the mock snapshot carries every field the UI reads", () => {
  mockReset(7);
  const snapshot = mockSnapshot();

  for (const key of ["ts", "intervalMs", "host", "cpu", "memory", "disks", "networks", "gpus", "processes", "counts"]) {
    assert.ok(key in snapshot, `snapshot is missing ${key}`);
  }
  for (const key of ["name", "os", "kernel", "arch", "uptimeSecs", "bootTime", "elevated", "seesAllUsers", "logicalCores", "physicalCores", "totalMemory", "selfPid"]) {
    assert.ok(key in snapshot.host, `host is missing ${key}`);
  }
  for (const key of ["brand", "vendor", "logical", "physical", "usage", "perCore", "frequencyMhz", "loadAvg", "topProcess"]) {
    assert.ok(key in snapshot.cpu, `cpu is missing ${key}`);
  }
  for (const key of ["total", "used", "available", "free", "totalSwap", "usedSwap", "usedPct"]) {
    assert.ok(key in snapshot.memory, `memory is missing ${key}`);
  }
  for (const key of [
    "pid", "ppid", "name", "description", "exe", "user", "session",
    "cpu", "cpuPerCore", "memory", "virtualMemory", "readBps", "writeBps",
    "threads", "handles", "priority", "status", "startTime", "runTimeSecs", "gpu",
  ]) {
    assert.ok(key in snapshot.processes[0], `process is missing ${key}`);
  }
  for (const key of ["name", "mountPoint", "kind", "fileSystem", "total", "available", "used", "usedPct", "readBps", "writeBps", "system"]) {
    assert.ok(key in snapshot.disks[0], `disk is missing ${key}`);
  }
  for (const key of ["name", "mac", "ipv4", "ipv6", "receivedBps", "transmittedBps", "totalReceived", "packetsIn"]) {
    assert.ok(key in snapshot.networks[0], `network is missing ${key}`);
  }
  for (const key of ["name", "vram", "shared", "vendor", "usage", "usageEngine"]) {
    assert.ok(key in snapshot.gpus[0], `gpu is missing ${key}`);
  }
  for (const key of ["processes", "apps", "threads", "handles", "suspended"]) {
    assert.ok(key in snapshot.counts, `counts is missing ${key}`);
  }
});

test("the mock machine stays inside the ranges the UI assumes", () => {
  mockReset(11);
  let snapshot = mockSnapshot();
  for (let tick = 0; tick < 5; tick += 1) {
    snapshot = mockSnapshot();
    assert.ok(snapshot.processes.length > 100, "the mock needs a realistic process count");
    assert.ok(snapshot.memory.used <= snapshot.memory.total);
    assert.ok(snapshot.cpu.usage >= 0 && snapshot.cpu.usage <= 100);
    assert.equal(snapshot.cpu.perCore.length, snapshot.cpu.logical);
    for (const process of snapshot.processes) {
      assert.ok(process.cpu >= 0, "cpu cannot be negative");
      assert.ok(process.memory > 0);
    }
  }
  assert.ok(snapshot.disks.length > 0 && snapshot.networks.length > 0 && snapshot.gpus.length > 0);
  assert.equal(mockDetail(snapshot.processes[0].pid).pid, snapshot.processes[0].pid);
});

test("the mock is deterministic for a fixed seed", () => {
  mockReset(99);
  const first = JSON.stringify(mockSnapshot().processes.slice(0, 25));
  mockReset(99);
  const second = JSON.stringify(mockSnapshot().processes.slice(0, 25));
  assert.equal(first, second);
});

/* ---------------------------------------------------------------- runner -- */

let failures = 0;
for (const { name, run } of tests) {
  try {
    run();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${name}`);
    for (const line of error.message.split("\n")) console.log(`        ${line}`);
  }
}

console.log(`\nui-selftest: ${tests.length - failures}/${tests.length} passed`);
process.exit(failures === 0 ? 0 : 1);
