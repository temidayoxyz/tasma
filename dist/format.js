/**
 * Number and label formatting.
 *
 * Pure functions only, no DOM: `tools/ui-selftest.mjs` runs this under Node so the
 * strings the dashboard shows are verified rather than eyeballed.
 */

const BINARY = ["B", "KB", "MB", "GB", "TB"];

/** "47.5" style decimal sizes for gigabytes - what a person reads on a spec sheet. */
export function gb(bytes, digits = 1) {
  return (bytes / 1024 / 1024 / 1024).toFixed(digits);
}

/** Binary-prefixed size, e.g. "410.4 MB". */
export function bytes(value, digits = 1) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < BINARY.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(size) : size.toFixed(digits)} ${BINARY[unit]}`;
}

/** Transfer rate, e.g. "2.3 MB/s". */
export function rate(perSecond, digits = 1) {
  if (!Number.isFinite(perSecond) || perSecond <= 0) return "0 B/s";
  return `${bytes(perSecond, digits)}/s`;
}

/** Percent with a stable number of decimals, clamped to 0-100. */
export function pct(value, digits = 1) {
  if (!Number.isFinite(value)) return "0";
  const clamped = Math.min(100, Math.max(0, value));
  return clamped.toFixed(digits);
}

/** Big-number formatting: keeps one decimal under 100, none above. */
export function compactPercent(value) {
  if (!Number.isFinite(value)) return "0";
  const clamped = Math.min(100, Math.max(0, value));
  if (clamped >= 100) return "100";
  if (clamped >= 10) return clamped.toFixed(clamped >= 99.5 ? 0 : 1);
  return clamped.toFixed(1);
}

/** "3h 41m", "12d 6h", "48s" - uptime style. */
export function duration(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${total % 60}s`;
  return `${total}s`;
}

export function clockNow(date = new Date()) {
  return date.toLocaleTimeString(undefined, { hour12: false });
}

export function hostClock(unixSeconds) {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Stable colour per app name, so the same process always gets the same tile. */
const TILE_COLOURS = [
  ["#3ddca1", "#2fd4c8"],
  ["#8b5cf6", "#c084fc"],
  ["#5b8def", "#22d3ee"],
  ["#f5a524", "#fbbf24"],
  ["#f472b6", "#fb7185"],
  ["#34d399", "#a3e635"],
  ["#818cf8", "#93c5fd"],
  ["#fb923c", "#f87171"],
];

export function tileColour(name) {
  let hash = 0;
  const text = (name || "?").toLowerCase();
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 100000;
  }
  const [from, to] = TILE_COLOURS[hash % TILE_COLOURS.length];
  return `linear-gradient(140deg, ${from}, ${to})`;
}

/** Two letters for the tile: "Google Chrome" -> "GC", "chrome.exe" -> "CH". */
export function initials(name) {
  const clean = (name || "?").replace(/\.(exe|com|bat|cmd|dll)$/i, "").trim();
  const words = clean.split(/[\s\-_.]+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase() || "?";
}

/** Heat bucket used for colouring CPU figures. */
export function heat(value) {
  if (!Number.isFinite(value)) return "cool";
  if (value >= 70) return "hot";
  if (value >= 35) return "warm";
  return "cool";
}

export function networkClass(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 1024) return "is-quiet";
  if (bytesPerSecond < 1024 * 1024) return "is-good";
  return "is-warn";
}

/** Collapses a raw engine name into something readable in a chip. */
export function engineLabel(engine) {
  if (!engine) return "busiest engine";
  return engine.replace(/([a-z])([A-Z])/g, "$1 $2");
}
