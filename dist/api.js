/**
 * Data access.
 *
 * One place that knows how to talk to the Rust side, so every view stays free of
 * transport details. When the page is opened outside the desktop shell (a plain
 * browser, or Node for the self-test) the mock source takes over, which is what
 * makes the UI quick to iterate on without rebuilding the binary.
 */

const bridge = typeof window !== "undefined" ? window.__TAURI__ : undefined;

export const isDesktop = Boolean(bridge?.core?.invoke);

async function call(command, args) {
  if (!isDesktop) throw new Error(`not running in the Tasma shell (wanted ${command})`);
  return bridge.core.invoke(command, args);
}

export const api = {
  snapshot: () => call("get_snapshot"),
  detail: (pid) => call("get_process_detail", { pid }),
  endTask: (pid) => call("end_task", { pid }),
  kill: (pid) => call("kill_process", { pid }),
  suspend: (pid) => call("suspend_process", { pid }),
  resume: (pid) => call("resume_process", { pid }),
  setPriority: (pid, level) => call("set_priority", { pid, level }),
  setEfficiency: (pid, enabled) => call("set_efficiency_mode", { pid, enabled }),
  runTask: (command) => call("run_task", { command }),
  reveal: (pid) => call("reveal_process", { pid }),
  setCompact: (on) => call("set_compact", { on }),
  relaunchElevated: () => call("relaunch_elevated"),
  appInfo: () => call("app_info"),
};

export async function appInfo() {
  try {
    return await api.appInfo();
  } catch {
    return {
      name: "Tasma",
      version: "browser preview",
      tauri: "—",
      rustc: "—",
      profile: "mock data",
    };
  }
}

/* --------------------------------------------------------------- mock data -- */

/** Deterministic PRNG so repeated runs (and the self-test) see the same machine. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KNOWN_APPS = [
  ["chrome.exe", "Google Chrome", 264, 640_000_000, 3.4, 1.2],
  ["msedge.exe", "Microsoft Edge", 312, 380_000_000, 1.1, 0.4],
  ["Code.exe", "Visual Studio Code", 498, 512_000_000, 4.2, 0.9],
  ["explorer.exe", "Windows Explorer", 144, 148_000_000, 0.6, 0.1],
  ["Spotify.exe", "Spotify", 221, 194_000_000, 0.9, 0.1],
  ["Teams.exe", "Microsoft Teams", 402, 292_000_000, 1.2, 0.2],
  ["Discord.exe", "Discord", 388, 176_000_000, 0.5, 0.1],
  ["steam.exe", "Steam", 260, 132_000_000, 0.3, 0.05],
  ["powershell.exe", "Windows PowerShell", 512, 96_000_000, 0.8, 0.2],
  ["WindowsTerminal.exe", "Windows Terminal", 610, 88_000_000, 1.4, 0.3],
  ["tasma.exe", "Tasma", 900, 74_000_000, 1.9, 0.2],
  ["dwm.exe", "Desktop Window Manager", 88, 210_000_000, 2.6, 1.6],
  ["MsMpEng.exe", "Antimalware Service Executable", 104, 322_000_000, 3.1, 0.3],
  ["SearchIndexer.exe", "Microsoft Windows Search Indexer", 118, 118_000_000, 1.1, 0.4],
  ["OneDrive.exe", "Microsoft OneDrive", 226, 108_000_000, 0.2, 0.05],
  ["nvcontainer.exe", "NVIDIA Container", 320, 64_000_000, 0.4, 0.1],
  ["audiodg.exe", "Windows Audio Device Graph Isolation", 172, 42_000_000, 0.7, 0.1],
  ["node.exe", "Node.js", 640, 268_000_000, 2.2, 0.6],
  ["python.exe", "Python", 660, 142_000_000, 1.7, 0.2],
  ["notepad.exe", "Notepad", 712, 24_000_000, 0.1, 0.02],
];

const SERVICE_TEMPLATES = [
  "Service Host: Network Service",
  "Service Host: Local System",
  "Service Host: Connected Devices",
  "Service Host: Print Spooler",
  "Service Host: Task Scheduler",
  "Service Host: Diagnostics",
  "Runtime Broker",
  "Windows Shell Experience Host",
  "Start Menu Experience Host",
  "Text Input Host",
  "Application Frame Host",
  "Client Server Runtime Process",
  "Local Security Authority Process",
  "Security Accounts Manager",
  "Device Association Service",
  "Windows Update Medic Service",
];

const USERS = [
  "TASMA\\Administrator",
  "NT AUTHORITY\\SYSTEM",
  "NT AUTHORITY\\LOCAL SERVICE",
  "TASMA\\Temidayo",
];

let mockState = null;

export function mockReset(seed = 20260930) {
  mockState = { random: mulberry32(seed), tick: 0 };
  return mockState;
}

function wander(random, value, jitter, min, max) {
  const next = value + (random() - 0.5) * jitter;
  return Math.min(max, Math.max(min, next));
}

/**
 * A believable snapshot: the curated apps above plus a long tail of service
 * processes, so the table has to cope with realistic row counts and the charts get
 * interesting traces.
 */
export function mockSnapshot() {
  if (!mockState) mockReset();
  const { random } = mockState;
  mockState.tick += 1;

  const logical = 12;
  const totalMemory = 68_719_476_736;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const processes = [];

  KNOWN_APPS.forEach(([name, description, pid, memory, cpuBase, diskBase], index) => {
    processes.push({
      pid,
      ppid: index === 0 ? 6112 : 1024,
      name,
      description,
      exe: `C:\\Program Files\\${description}\\${name}`,
      user: index % 7 === 0 ? USERS[1] : USERS[0],
      session: index % 7 === 0 ? 0 : 1,
      cpu: wander(random, cpuBase, cpuBase * 0.9, 0, 92) * (index === 2 ? 5 : 1),
      cpuPerCore: wander(random, cpuBase * logical, cpuBase * 8, 0, 380),
      memory: Math.round(wander(random, memory, memory * 0.03, memory * 0.6, memory * 1.4)),
      virtualMemory: Math.round(memory * 1.7),
      readBps: wander(random, diskBase * 120_000, diskBase * 400_000, 0, 9_000_000),
      writeBps: wander(random, diskBase * 90_000, diskBase * 250_000, 0, 6_000_000),
      threads: 6 + Math.round(random() * 48),
      handles: 120 + Math.round(random() * 900),
      priority: index === 11 ? "High" : "Normal",
      status: index === 18 ? "Suspended" : "Running",
      startTime: nowSeconds - 3600 - index * 137,
      runTimeSecs: 3600 + index * 137,
      gpu: index < 4 || index === 11 ? wander(random, index === 2 ? 12 : 2, 6, 0, 60) : null,
    });
  });

  for (let index = 0; index < 230; index += 1) {
    processes.push({
      pid: 1100 + index * 4,
      ppid: 720 + (index % 6),
      name: "svchost.exe",
      description: SERVICE_TEMPLATES[index % SERVICE_TEMPLATES.length],
      exe: "C:\\Windows\\System32\\svchost.exe",
      user: USERS[index % 3],
      session: index % 5 === 0 ? 0 : 1,
      cpu: wander(random, 0.15, 0.6, 0, 6),
      cpuPerCore: wander(random, 1.5, 6, 0, 40),
      memory: Math.round(wander(random, 22_000_000, 18_000_000, 3_000_000, 180_000_000)),
      virtualMemory: 12_000_000,
      readBps: random() < 0.15 ? random() * 400_000 : 0,
      writeBps: random() < 0.1 ? random() * 200_000 : 0,
      threads: 3 + Math.round(random() * 24),
      handles: 40 + Math.round(random() * 420),
      priority: "Normal",
      status: "Running",
      startTime: nowSeconds - 86400,
      runTimeSecs: 86400 + index,
      gpu: null,
    });
  }

  const cpuUsage = wander(random, mockState.cpuUsage ?? 18, 9, 1, 96);
  mockState.cpuUsage = cpuUsage;
  const usedMemory = wander(
    random,
    mockState.usedMemory ?? 29_000_000_000,
    420_000_000,
    12_000_000_000,
    60_000_000_000,
  );
  mockState.usedMemory = usedMemory;

  return {
    ts: Date.now(),
    intervalMs: 1000,
    host: {
      name: "TASMA-RIG",
      os: "Windows 11 Pro",
      kernel: "10.0.26100",
      arch: "x86_64",
      uptimeSecs: 3 * 3600 + 41 * 60 + 12 + mockState.tick,
      bootTime: nowSeconds - 14872,
      elevated: false,
      seesAllUsers: false,
      logicalCores: logical,
      physicalCores: 8,
      totalMemory,
      selfPid: 900,
    },
    cpu: {
      brand: "AMD Ryzen 7 7840U w/ Radeon 780M Graphics",
      vendor: "AuthenticAMD",
      logical,
      physical: 8,
      usage: cpuUsage,
      perCore: Array.from({ length: logical }, () => wander(random, 15, 26, 0, 100)),
      frequencyMhz: Math.round(wander(random, 3600, 700, 1800, 5100)),
      loadAvg: [wander(random, 1.2, 0.8, 0, 8), 0.9, 0.7],
      topProcess: "Visual Studio Code",
    },
    memory: {
      total: totalMemory,
      used: usedMemory,
      available: totalMemory - usedMemory,
      free: totalMemory - usedMemory - 4_000_000_000,
      totalSwap: 19_327_352_832,
      usedSwap: wander(random, 2_400_000_000, 400_000_000, 0, 12_000_000_000),
      usedPct: (usedMemory / totalMemory) * 100,
    },
    disks: [
      {
        name: "Samsung SSD 990 PRO 2TB",
        mountPoint: "C:\\",
        kind: "SSD",
        fileSystem: "NTFS",
        total: 1_999_000_000_000,
        available: 604_000_000_000,
        used: 1_395_000_000_000,
        usedPct: 69.8,
        removable: false,
        readBps: wander(random, 2_400_000, 6_000_000, 0, 220_000_000),
        writeBps: wander(random, 900_000, 3_000_000, 0, 140_000_000),
        system: true,
      },
      {
        name: "WD Blue SN570 1TB",
        mountPoint: "D:\\",
        kind: "SSD",
        fileSystem: "NTFS",
        total: 1_000_000_000_000,
        available: 384_000_000_000,
        used: 616_000_000_000,
        usedPct: 61.6,
        removable: false,
        readBps: wander(random, 400_000, 2_000_000, 0, 120_000_000),
        writeBps: wander(random, 200_000, 1_000_000, 0, 90_000_000),
        system: false,
      },
    ],
    networks: [
      {
        name: "Intel Wi-Fi 6E AX211",
        mac: "8C:1D:96:4A:2B:11",
        ipv4: ["192.168.1.42/24"],
        ipv6: [],
        receivedBps: wander(random, 340_000, 900_000, 0, 12_000_000),
        transmittedBps: wander(random, 60_000, 240_000, 0, 4_000_000),
        totalReceived: 8_412_000_000,
        totalTransmitted: 1_204_000_000,
        packetsIn: 6_204_112,
        packetsOut: 3_998_211,
      },
      {
        name: "Realtek Gaming 2.5GbE",
        mac: "10:7C:61:00:AA:19",
        ipv4: [],
        ipv6: [],
        receivedBps: 0,
        transmittedBps: 0,
        totalReceived: 412_000,
        totalTransmitted: 88_000,
        packetsIn: 2_140,
        packetsOut: 1_884,
      },
    ],
    gpus: [
      {
        name: "AMD Radeon 780M",
        vram: 4_294_967_296,
        shared: 34_359_738_368,
        vendor: "AMD",
        software: false,
        usage: wander(random, 14, 22, 0, 100),
        usageEngine: "3D",
      },
    ],
    processes,
    counts: {
      processes: processes.length,
      apps: new Set(processes.map((process) => process.description)).size,
      threads: processes.reduce((total, process) => total + (process.threads || 0), 0),
      handles: processes.reduce((total, process) => total + (process.handles || 0), 0),
      suspended: processes.filter((process) => process.status === "Suspended").length,
    },
  };
}

export function mockDetail(pid) {
  const snapshot = mockSnapshot();
  const process = snapshot.processes.find((entry) => entry.pid === pid) || snapshot.processes[0];
  return {
    pid: process.pid,
    cmd: [process.exe || process.name],
    cwd: process.exe ? process.exe.replace(/\\[^\\]+$/, "") : null,
    exe: process.exe,
    description: process.description,
    root: null,
    user: process.user,
    environmentCount: 48,
    openFiles: 12,
  };
}

/** In mock mode every action succeeds, so the whole UI flow can be walked through. */
export function mockAction(name, detail) {
  return {
    ok: true,
    message: `Preview mode: ${name}${detail ? ` ${detail}` : ""}`,
    needsElevation: false,
  };
}

