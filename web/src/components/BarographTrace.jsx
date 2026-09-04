import { useId, useMemo } from "react";

/**
 * The barograph trace — the one element carried across every surface.
 *
 * A drum barograph inks a continuous line onto paper; when the instrument
 * fails, the paper shows it in the ink itself. That is the vocabulary here:
 * a spike is a blot, a frozen sensor is a flat run drawn in a dashed hand, a
 * dropout is a lifted pen. Faults are never a coloured dot bolted onto a line
 * chart.
 *
 * Rendered at three scales — `sparkline` in a table row, `panel` on the
 * station view, `ghost` behind the cover headline.
 */
export default function BarographTrace({
  samples,
  param = "temp_c",
  variant = "panel",
  expected = null,
  marks = [],
  height,
  className = "",
  showAxis = false,
}) {
  const uid = useId().replace(/:/g, "");
  const h = height ?? (variant === "sparkline" ? 26 : variant === "ghost" ? 320 : 190);
  const w = 1000;

  const geom = useMemo(() => build(samples, param, w, h, expected), [samples, param, w, h, expected]);
  if (!geom) return <div style={{ height: h }} aria-hidden="true" />;

  const { segments, gaps, blots, flats, min, max, pts } = geom;
  const stroke = variant === "ghost" ? "var(--rule-bright)" : "var(--bone)";
  const width = variant === "sparkline" ? 1.25 : variant === "ghost" ? 1 : 1.5;

  const expectedPath =
    expected && variant === "panel"
      ? line(pts.map((p, i) => ({ x: p.x, y: scale(expected[i], min, max, h) })))
      : null;

  return (
    <svg
      className={`trace trace--${variant} ${className}`}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ height: h, width: "100%", display: "block" }}
      role="img"
      aria-label={`${param} trace over the last ${samples.length} samples`}
    >
      <defs>
        {/* The pen wobbles. A perfectly smooth line reads as a chart; a very
            slightly displaced one reads as ink on paper. */}
        <filter id={`ink${uid}`} x="-2%" y="-20%" width="104%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" />
          <feDisplacementMap in="SourceGraphic" scale={variant === "sparkline" ? 0.5 : 1.1} />
        </filter>
      </defs>

      {showAxis && (
        <g className="trace__grid">
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1="0" x2={w} y1={h * f} y2={h * f} />
          ))}
        </g>
      )}

      {expectedPath && <path className="trace__expected" d={expectedPath} />}

      {segments.map((d, i) => (
        <path
          key={`s${i}`}
          d={d}
          fill="none"
          stroke={stroke}
          strokeWidth={width}
          strokeLinecap="round"
          strokeLinejoin="round"
          filter={`url(#ink${uid})`}
          vectorEffect="non-scaling-stroke"
        />
      ))}

      {/* Flat runs: the pen is still moving across the drum but the value is
          not changing, so the ink lays down as a dashed rule. */}
      {flats.map((f, i) => (
        <line
          key={`f${i}`}
          className="trace__flat"
          x1={f.x0}
          x2={f.x1}
          y1={f.y}
          y2={f.y}
        />
      ))}

      {/* Lifted pen: the gap is the evidence, the hairline only makes it legible. */}
      {gaps.map((g, i) => (
        <line
          key={`g${i}`}
          className="trace__gap"
          x1={g.x0}
          x2={g.x1}
          y1={h / 2}
          y2={h / 2}
        />
      ))}

      {blots.map((b, i) => (
        <g key={`b${i}`} className="trace__blot">
          <circle cx={b.x} cy={b.y} r={variant === "sparkline" ? 2.2 : 4.5} />
          <circle cx={b.x} cy={b.y} r={variant === "sparkline" ? 4.5 : 11} className="trace__halo" />
        </g>
      ))}

      {marks.map((m, i) => (
        <line
          key={`m${i}`}
          className="trace__playhead"
          x1={m * w}
          x2={m * w}
          y1="0"
          y2={h}
        />
      ))}
    </svg>
  );
}

const scale = (v, min, max, h) => {
  const pad = h * 0.14;
  const span = max - min || 1;
  return h - pad - ((v - min) / span) * (h - pad * 2);
};

function build(samples, param, w, h, expected) {
  if (!samples?.length) return null;
  const vals = samples.map((s) => s[param]).filter((v) => v !== null && v !== undefined);
  if (!vals.length) return null;
  // The learned normal shares the axis with the reported value: during a drift
  // the two separate by more than the reported range, and if the domain came
  // from the readings alone the expectation would be clipped off the panel —
  // hiding exactly the gap the panel exists to show.
  const all = expected ? vals.concat(expected.filter((v) => v !== null && v !== undefined)) : vals;
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (max - min < 1e-6) {
    min -= 0.5;
    max += 0.5;
  }

  const stepX = w / Math.max(samples.length - 1, 1);
  const pts = samples.map((s, i) => ({
    x: i * stepX,
    y: s[param] === null || s[param] === undefined ? null : scale(s[param], min, max, h),
    v: s[param],
    flagged: s.flagged,
    kind: s.kind,
  }));

  // Split into inked segments wherever the pen lifted.
  const segments = [];
  const gaps = [];
  let run = [];
  let gapStart = null;
  for (const p of pts) {
    if (p.y === null) {
      if (run.length > 1) segments.push(line(run));
      if (run.length) gapStart = run[run.length - 1].x;
      run = [];
      if (gapStart !== null) gaps.push({ x0: gapStart, x1: p.x });
    } else {
      run.push(p);
    }
  }
  if (run.length > 1) segments.push(line(run));
  // Merge adjacent gap slivers into one span.
  const merged = [];
  for (const g of gaps) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.x1 - g.x0) < stepX * 1.5) last.x1 = g.x1;
    else merged.push({ ...g });
  }

  const blots = pts.filter((p) => p.y !== null && p.kind === "spike");

  // Flat runs of six or more identical samples.
  const flats = [];
  let i = 0;
  while (i < pts.length) {
    if (pts[i].v === null) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < pts.length && pts[j + 1].v !== null && Math.abs(pts[j + 1].v - pts[i].v) < 1e-4) j++;
    if (j - i >= 5) flats.push({ x0: pts[i].x, x1: pts[j].x, y: pts[i].y });
    i = j + 1;
  }

  return { segments, gaps: merged, blots, flats, min, max, pts };
}

/** Catmull-Rom through the points, converted to cubic béziers. */
function line(p) {
  if (p.length < 2) return "";
  let d = `M ${p[0].x.toFixed(2)} ${p[0].y.toFixed(2)}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] ?? p[i];
    const p1 = p[i];
    const p2 = p[i + 1];
    const p3 = p[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}
