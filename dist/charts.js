/**
 * Canvas widgets.
 *
 * The look comes from the reference art: dot-matrix traces rather than filled
 * areas, so a 60-sample history still reads as a texture instead of a blob. Every
 * widget keeps its own history and redraws only when it is given new data - there is
 * no animation loop eating CPU, which matters in a process monitor.
 *
 * Colours come from CSS custom properties (`--tone-*`, `--dot-faint`), so the light
 * and dark themes are the stylesheet's business and the cache below is refreshed
 * whenever the theme changes.
 */

const DPR = () => Math.min(window.devicePixelRatio || 1, 2);

let palette = null;

/** Reads the theme's chart colours once per theme change, not once per frame. */
export function refreshPalette() {
  const styles = getComputedStyle(document.documentElement);
  const read = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;

  palette = {
    faint: read("--dot-faint", "rgba(255,255,255,0.07)"),
    track: read("--donut-track", "rgba(255,255,255,0.08)"),
    tones: {
      green: { from: read("--tone-green-from", "#1fbf8b"), to: read("--tone-green-to", "#3ddca1"), hot: read("--tone-green-hot", "#f5a524") },
      violet: { from: read("--tone-violet-from", "#7c3aed"), to: read("--tone-violet-to", "#c084fc"), hot: read("--tone-violet-hot", "#f472b6") },
      blue: { from: read("--tone-blue-from", "#3b82f6"), to: read("--tone-blue-to", "#22d3ee"), hot: read("--tone-blue-hot", "#a78bfa") },
      amber: { from: read("--tone-amber-from", "#f59e0b"), to: read("--tone-amber-to", "#fbbf24"), hot: read("--tone-amber-hot", "#f87171") },
    },
  };
  return palette;
}

function colours() {
  return palette ?? refreshPalette();
}

function context(canvas) {
  const ratio = DPR();
  const width = canvas.clientWidth || 240;
  const height = canvas.clientHeight || 46;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function mixed(tone, ratio) {
  // Above ~78% of the scale the trace switches to the "hot" colour so a pegged CPU
  // reads as hot at a glance instead of just looking busy.
  const stops = colours().tones[tone] ?? colours().tones.green;
  return ratio < 0.78 ? stops.to : stops.hot;
}


export class DotChart {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{max?: number, samples?: number, rows?: number, tone?: string}} options
   */
  constructor(canvas, { max = 100, samples = 60, rows = 7, tone = "green" } = {}) {
    this.canvas = canvas;
    this.max = max;
    this.samples = samples;
    this.rows = rows;
    this.tone = tone;
    this.values = new Array(samples).fill(0);
    this.peak = 0;
    this.render();
  }

  push(value) {
    const numeric = Number.isFinite(value) ? value : 0;
    this.values.push(Math.max(0, numeric));
    while (this.values.length > this.samples) this.values.shift();
    this.peak = Math.max(this.peak * 0.96, numeric);
    this.render();
  }

  reset(value = 0) {
    this.values = new Array(this.samples).fill(value);
    this.peak = 0;
    this.render();
  }

  /** The highest sample on screen, used by the "recent peak" chips. */
  get visiblePeak() {
    return this.values.reduce((top, value) => Math.max(top, value), 0);
  }

  render() {
    const canvas = this.canvas;
    if (!canvas || !canvas.isConnected) return;
    const { ctx, width, height } = context(canvas);

    const gap = 3.4;
    const columns = Math.max(8, Math.min(this.values.length, Math.floor(width / gap)));
    const series = this.values.slice(-columns);
    const step = width / columns;
    const radius = Math.min(1.6, Math.max(1, step * 0.28));
    const rowGap = height / (this.rows + 1);
    const scale = this.max > 0 ? this.max : 1;

    for (let column = 0; column < columns; column += 1) {
      const value = series[column] ?? 0;
      const ratio = Math.min(1, value / scale);
      const filled = Math.round(ratio * this.rows);
      const x = step * (column + 0.5);

      for (let row = 0; row < this.rows; row += 1) {
        const y = height - rowGap * (row + 0.7);
        const active = row < filled;
        const depth = row / this.rows;

        if (!active) {
          // Faint baseline dots: the panel keeps its grid when the machine idles.
          ctx.globalAlpha = 1;
          ctx.fillStyle = colours().faint;
        } else {
          ctx.globalAlpha = 0.35 + depth * 0.65;
          ctx.fillStyle = mixed(this.tone, ratio * 0.5 + depth * 0.5);
        }
        ctx.beginPath();
        ctx.arc(x, y, active ? radius * (0.75 + depth * 0.5) : radius * 0.55, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }
}

/** Donut used for memory balance: one ring, generous rounding, no legend clutter. */
export function drawDonut(canvas, ratio, { label = "", tone = "violet", track } = {}) {
  if (!canvas || !canvas.isConnected) return;
  const { ctx, width, height } = context(canvas);
  const size = Math.min(width, height);
  const line = size * 0.11;
  const radius = size / 2 - line / 2 - 1;
  const centre = size / 2;
  const clamped = Math.min(1, Math.max(0, ratio || 0));

  ctx.lineWidth = line;
  ctx.lineCap = "round";
  ctx.strokeStyle = track ?? colours().track;
  ctx.beginPath();
  ctx.arc(centre, centre, radius, 0, Math.PI * 2);
  ctx.stroke();

  if (clamped > 0.001) {
    const stops = colours().tones[tone] ?? colours().tones.violet;
    const gradient = ctx.createLinearGradient(0, size, size, 0);
    gradient.addColorStop(0, stops.from);
    gradient.addColorStop(1, stops.to);
    ctx.strokeStyle = gradient;
    ctx.beginPath();
    ctx.arc(centre, centre, radius, -Math.PI / 2, -Math.PI / 2 + clamped * Math.PI * 2);
    ctx.stroke();
  }
  canvas.dataset.label = label;
}

/** Dot bar for volumes and memory: `dots` lit out of `total`. */
export function dotBar(element, ratio, dots = 28) {
  if (!element) return;
  const lit = Math.round(Math.min(1, Math.max(0, ratio || 0)) * dots);
  if (element.childElementCount !== dots) {
    element.replaceChildren(
      ...Array.from({ length: dots }, () => element.ownerDocument.createElement("i")),
    );
  }
  [...element.children].forEach((dot, index) => {
    dot.classList.toggle("on", index < lit);
  });
}
