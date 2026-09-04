/**
 * Isobars from the station network.
 *
 * The stations are scattered, so the field is filled by inverse-distance
 * weighting onto a coarse grid, then contoured with marching squares. This is
 * the same shape of computation a real analysis chart uses, at a much cruder
 * resolution — enough to show a system moving across the network, not enough
 * to forecast from.
 */

const COLS = 44;
const ROWS = 48;
/** Kernel bandwidth in map units — about the mean spacing between stations. */
const BAND = 165;

/** @param points {{x:number,y:number,v:number}[]} */
export function field(points, w, h) {
  const grid = new Float32Array(COLS * ROWS);
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      const x = (i / (COLS - 1)) * w;
      const y = (j / (ROWS - 1)) * h;
      let num = 0;
      let den = 0;
      for (const p of points) {
        const d2 = (p.x - x) ** 2 + (p.y - y) ** 2;
        // Gaussian rather than a plain inverse power: an inverse power has a
        // singularity at every station, which pulls the field into a bullseye
        // around each pin instead of the broad systems an analysis chart shows.
        // BAND is roughly the mean station spacing, so the field is smoothed to
        // synoptic scale and no longer passes exactly through each reading.
        const wgt = Math.exp(-d2 / (2 * BAND * BAND));
        num += wgt * p.v;
        den += wgt;
      }
      grid[j * COLS + i] = num / den;
    }
  }
  return smooth(smooth(grid));
}

/** One pass of a 3x3 box blur over the grid, edges clamped. */
function smooth(grid) {
  const out = new Float32Array(grid.length);
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      let sum = 0;
      let n = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const jj = Math.min(ROWS - 1, Math.max(0, j + dj));
          const ii = Math.min(COLS - 1, Math.max(0, i + di));
          sum += grid[jj * COLS + ii];
          n++;
        }
      }
      out[j * COLS + i] = sum / n;
    }
  }
  return out;
}

/** Marching-squares isolines at the given levels, as SVG path strings. */
export function isolines(grid, levels, w, h) {
  const dx = w / (COLS - 1);
  const dy = h / (ROWS - 1);
  const out = [];

  for (const level of levels) {
    const segs = [];
    for (let j = 0; j < ROWS - 1; j++) {
      for (let i = 0; i < COLS - 1; i++) {
        const a = grid[j * COLS + i];
        const b = grid[j * COLS + i + 1];
        const c = grid[(j + 1) * COLS + i + 1];
        const d = grid[(j + 1) * COLS + i];
        const idx = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
        if (idx === 0 || idx === 15) continue;

        const x0 = i * dx;
        const y0 = j * dy;
        const top = { x: x0 + dx * t(a, b, level), y: y0 };
        const right = { x: x0 + dx, y: y0 + dy * t(b, c, level) };
        const bottom = { x: x0 + dx * t(d, c, level), y: y0 + dy };
        const left = { x: x0, y: y0 + dy * t(a, d, level) };

        const cases = {
          1: [left, bottom], 2: [bottom, right], 3: [left, right],
          4: [top, right], 5: [left, top, bottom, right], 6: [top, bottom],
          7: [left, top], 8: [left, top], 9: [top, bottom],
          10: [left, bottom, top, right], 11: [top, right],
          12: [left, right], 13: [bottom, right], 14: [left, bottom],
        };
        const pts = cases[idx];
        for (let k = 0; k < pts.length; k += 2) segs.push([pts[k], pts[k + 1]]);
      }
    }
    if (segs.length) out.push({ level, d: chain(segs).map(curve).join(" ") });
  }
  return out;
}

/**
 * Marching squares emits unordered fragments. Joining them end to end gives
 * continuous isobars, which is what lets them be drawn as curves and animated
 * as single strokes rather than a cloud of dashes.
 */
function chain(segs) {
  const key = (p) => `${Math.round(p.x * 4)},${Math.round(p.y * 4)}`;
  const ends = new Map();
  for (const s of segs) {
    for (const p of [s[0], s[1]]) {
      const k = key(p);
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push(s);
    }
  }
  const used = new Set();
  const lines = [];
  for (const seed of segs) {
    if (used.has(seed)) continue;
    used.add(seed);
    const line = [seed[0], seed[1]];
    // Extend from both ends until no unused segment shares the endpoint.
    for (const dir of [1, 0]) {
      for (;;) {
        const tip = dir ? line[line.length - 1] : line[0];
        const next = (ends.get(key(tip)) || []).find((s) => !used.has(s));
        if (!next) break;
        used.add(next);
        const far = key(next[0]) === key(tip) ? next[1] : next[0];
        if (dir) line.push(far);
        else line.unshift(far);
      }
    }
    if (line.length > 2) lines.push(line);
  }
  return lines;
}

/** Catmull-Rom through the polyline, expressed as cubic beziers. */
function curve(pts) {
  const f = (n) => n.toFixed(1);
  let d = `M ${f(pts[0].x)} ${f(pts[0].y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(p2.x)} ${f(p2.y)}`;
  }
  return d;
}

const t = (a, b, level) => {
  const denom = b - a;
  return Math.abs(denom) < 1e-9 ? 0.5 : Math.max(0, Math.min(1, (level - a) / denom));
};

/** Levels spanning the field, rounded to a readable interval. */
export function levelsFor(grid, interval = 2) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of grid) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const start = Math.ceil(min / interval) * interval;
  const out = [];
  for (let l = start; l <= max; l += interval) out.push(l);
  return out;
}
