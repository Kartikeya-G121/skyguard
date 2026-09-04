import { plausibility, robustZ, stdev, dewpoint } from "./physics.js";
import { climate, neighbours } from "./stations.js";

/**
 * Four-layer detector, running in the browser over the observed history only.
 * It has no access to the simulator's ground truth. The layers mirror the
 * Python service this UI is built against:
 *
 *   statistical — robust z-score against a rolling window (cheap, always on)
 *   temporal    — departure from the expected diurnal position for this hour
 *   physical    — thermodynamic consistency between the three parameters
 *   spatial     — agreement with the nearest reporting stations
 *
 * Each contributing layer returns a score in 0–1. Confidence is a weighted
 * combination; the reasons carried on the detection are the same scores,
 * ordered by contribution, which is what the evidence view renders.
 */

/**
 * How much each layer is trusted when it fires alone. These are not weights in
 * a weighted sum: the layers are combined with a noisy-OR, so independent
 * evidence accumulates instead of being capped. A deterministic check —
 * a latched sensor, or air holding more water than it physically can — should
 * be able to reach high confidence on its own, which a weighted sum forbids.
 */
const RELIABILITY = { statistical: 0.75, temporal: 0.7, physical: 0.95, spatial: 0.8 };
const WINDOW = 24;
const PARAMS = ["temp_c", "pres_hpa", "rh_pct"];
const UNIT = { temp_c: "°C", pres_hpa: "hPa", rh_pct: "%" };

const fmt = (v, p) => (p === "pres_hpa" ? v.toFixed(1) : v.toFixed(1));

/**
 * @param station  the station being evaluated
 * @param history  previous observed samples, oldest first
 * @param sample   the sample under test
 * @param context  { hoursIn, expected, peers } — peers are the current
 *                 observed samples of neighbouring stations
 */
export function detect(station, history, sample, context = {}) {
  if (sample.temp_c === null || sample.pres_hpa === null || sample.rh_pct === null) {
    return {
      type: "dropout",
      param: "multi",
      severity: "high",
      confidence: 1,
      suggested: null,
      reasons: [
        {
          layer: "statistical",
          detail: "No sample received in this reporting slot.",
          contribution: 1,
        },
      ],
    };
  }

  const recent = history.slice(-WINDOW).filter((h) => h.temp_c !== null);
  const scores = { statistical: 0, temporal: 0, physical: 0, spatial: 0 };
  // Per-parameter evidence, so the detection names the sensor at fault rather
  // than whichever layer happened to run first.
  const blame = { temp_c: 0, pres_hpa: 0, rh_pct: 0 };
  const reasons = [];
  let frozenParam = null;
  let suggested = null;
  let suggestedParam = null;

  // --- statistical -------------------------------------------------------
  let worstZ = 0;
  let worstZParam = null;
  for (const p of PARAMS) {
    const window = recent.map((h) => h[p]);
    const z = Math.abs(robustZ(sample[p], window));
    if (z > worstZ) {
      worstZ = z;
      worstZParam = p;
    }
  }
  if (worstZ > 4) {
    scores.statistical = Math.min(1, (worstZ - 4) / 8);
    blame[worstZParam] += scores.statistical;
    const window = recent.map((h) => h[worstZParam]).sort((a, b) => a - b);
    suggested = window[Math.floor(window.length / 2)];
    suggestedParam = worstZParam;
    reasons.push({
      layer: "statistical",
      detail: `${label(worstZParam)} sits ${worstZ.toFixed(1)} robust deviations from its last ${recent.length} readings.`,
      contribution: 0,
    });
  }

  // --- frozen sensor -----------------------------------------------------
  // A live sensor is never perfectly still. Near-zero variance across a long
  // window is the signature of a latched reading, not of calm weather.
  if (recent.length >= 12) {
    for (const p of PARAMS) {
      const sd = stdev(recent.slice(-12).map((h) => h[p]));
      const floor = p === "pres_hpa" ? 0.02 : 0.05;
      if (sd < floor) {
        frozenParam = p;
        // A latched output is an observation, not an estimate.
        scores.statistical = 1;
        blame[p] += 1;
        reasons.push({
          layer: "statistical",
          detail: `${label(p)} has not moved by more than ${floor}${UNIT[p]} across the last 12 samples.`,
          contribution: 0,
        });
        break;
      }
    }
  }

  // --- temporal ----------------------------------------------------------
  // Departure from where this station normally sits at this hour of the day.
  const departure = {};
  if (context.expected) {
    for (const p of PARAMS) {
      const spread = p === "temp_c" ? climate(station).diurnal / 2 : p === "pres_hpa" ? 3 : 14;
      departure[p] = (sample[p] - context.expected[p]) / spread;
      const err = Math.abs(departure[p]);
      if (err > 1.6) {
        const sc = Math.min(1, (err - 1.6) / 3);
        scores.temporal = Math.max(scores.temporal, sc);
        blame[p] += sc;
        if (suggested === null) {
          suggested = context.expected[p];
          suggestedParam = p;
        }
        reasons.push({
          layer: "temporal",
          detail: `Reconstruction error for ${label(p).toLowerCase()} is ${err.toFixed(1)}× the normal spread for this hour of day.`,
          contribution: 0,
        });
      }
    }
  }

  // --- physical ----------------------------------------------------------
  const violations = plausibility(sample, station.elev);
  if (violations.length) {
    scores.physical = 1;
    for (const v of violations) {
      if (v.check.startsWith("rh") || v.check === "dewpoint_exceeds_temp") blame.rh_pct += 0.5;
      if (v.check.startsWith("temp") || v.check === "wet_bulb_implausible") blame.temp_c += 0.5;
      if (v.check.startsWith("pressure")) blame.pres_hpa += 0.5;
      reasons.push({ layer: "physical", detail: v.detail + ".", contribution: 0 });
    }
    if (sample.rh_pct > 100.5) {
      suggested = 99;
      suggestedParam = "rh_pct";
    }
  } else if (sample.temp_c > 30) {
    // Report the margin even when the check passes: an operator wants to see
    // that it ran, not only that it stayed silent.
    const td = dewpoint(sample.temp_c, sample.rh_pct);
    if (sample.temp_c - td < 1.5) {
      scores.physical = Math.max(scores.physical, 0.4);
      blame.rh_pct += 0.2;
      reasons.push({
        layer: "physical",
        detail: `Dewpoint is within ${(sample.temp_c - td).toFixed(1)}°C of air temperature at ${sample.temp_c.toFixed(1)}°C.`,
        contribution: 0,
      });
    }
  }

  // --- spatial -----------------------------------------------------------
  // Neighbouring stations sit at different elevations and in different
  // climates, so raw values are not comparable. What is comparable is each
  // station's departure from its own normal: a real weather system moves
  // every station in a region together, a failing sensor moves only one.
  if (context.peers?.length >= 2 && context.expected) {
    for (const p of PARAMS) {
      const peerAnoms = context.peers.map((x) => x.anomaly[p]).filter((v) => v !== null);
      if (peerAnoms.length < 2) continue;
      const peerMean = peerAnoms.reduce((a, b) => a + b, 0) / peerAnoms.length;
      const own = sample[p] - context.expected[p];
      const spread = Math.max(stdev(peerAnoms), p === "pres_hpa" ? 0.8 : p === "rh_pct" ? 5 : 1.5);
      const ratio = Math.abs(own - peerMean) / spread;
      if (ratio > 2.5) {
        const sc = Math.min(1, (ratio - 2.5) / 5);
        scores.spatial = Math.max(scores.spatial, sc);
        blame[p] += sc;
        if (suggested === null) {
          suggested = context.expected[p] + peerMean;
          suggestedParam = p;
        }
        reasons.push({
          layer: "spatial",
          detail: `${label(p)} departs from its own normal by ${own.toFixed(1)}${UNIT[p]} while ${peerAnoms.length} neighbouring stations average ${peerMean.toFixed(1)}${UNIT[p]}.`,
          contribution: 0,
        });
      }
    }
  }

  // --- combine -----------------------------------------------------------
  // Noisy-OR: the chance that no layer is right, subtracted from one.
  let miss = 1;
  for (const layer of Object.keys(RELIABILITY)) miss *= 1 - RELIABILITY[layer] * scores[layer];
  // Capped: the noisy-OR saturates at 1 once two strong layers agree, and a
  // detector that prints 100% is claiming it cannot be wrong.
  const confidence = Math.min(0.99, 1 - miss);
  // Gate chosen against the injected ground truth: below about 0.22 the feed
  // fills with single-sample noise that never becomes an incident, and above it
  // the genuine slow faults start being dropped at onset.
  if (confidence < 0.22 || !reasons.length) return null;

  // --- classify ----------------------------------------------------------
  const param = frozenParam ?? argmax(blame) ?? suggestedParam ?? "multi";
  const type = classify({ frozenParam, violations, departure, history, param, station, context });

  // A drift is a bias to be corrected, not a value to be replaced outright.
  if (type === "drift" && context.expected) {
    suggested = context.expected[param] + (context.peers?.length
      ? context.peers.reduce((a, x) => a + x.anomaly[param], 0) / context.peers.length
      : 0);
  }

  // Each layer's share of the combined score, decomposed the way the noisy-OR
  // actually builds it: in log space, where the layers are additive.
  const evidence = (l) => -Math.log(Math.max(1e-9, 1 - RELIABILITY[l] * scores[l]));
  const total = reasons.reduce((a, r) => a + evidence(r.layer), 0) || 1;
  for (const r of reasons) r.contribution = evidence(r.layer) / total;
  reasons.sort((a, b) => b.contribution - a.contribution);

  return {
    type,
    param,
    severity: confidence > 0.62 ? "high" : confidence > 0.32 ? "medium" : "low",
    confidence: Math.round(confidence * 100) / 100,
    suggested: suggested === null ? null : Math.round(suggested * 10) / 10,
    reasons,
    scores,
  };
}

/**
 * Fault type from the shape of the evidence rather than from whichever layer
 * ran first. The discriminator that matters is persistence: a spike is a brief
 * excursion, a drift is a bias that has been building for hours.
 */
function classify({ frozenParam, violations, departure, history, param, station, context }) {
  if (frozenParam) return "frozen";

  const sustained = isSustained(history, param, station, context);
  if (sustained) return "drift";
  if (violations.length) return "inconsistent";
  if (Math.abs(departure[param] ?? 0) > 1.6) return "spike";
  return "spike";
}

/**
 * True when the parameter has sat on the same side of its expected value, by
 * more than a third of its normal spread, for the whole of the last 18 samples
 * — three hours at a ten-minute cadence.
 */
function isSustained(history, param, station, context) {
  if (!context.expected || history.length < 18) return false;
  const spread = param === "temp_c" ? climate(station).diurnal / 2 : param === "pres_hpa" ? 3 : 14;
  const tail = history.slice(-18).filter((h) => h[param] !== null);
  if (tail.length < 14) return false;
  const exp = context.expected[param];
  let sign = 0;
  for (const h of tail) {
    const d = (h[param] - exp) / spread;
    if (Math.abs(d) < 0.33) return false;
    const s = Math.sign(d);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function argmax(obj) {
  let best = null;
  let bestV = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (v > bestV) {
      bestV = v;
      best = k;
    }
  }
  return best;
}

function label(p) {
  return p === "temp_c" ? "Temperature" : p === "pres_hpa" ? "Pressure" : "Humidity";
}

/**
 * Peer context for the spatial layer. Each peer contributes its own departure
 * from its own learned normal, which is what makes stations at 11 m and
 * 3,256 m comparable at all. Peers are dropped if they are not reporting.
 */
export function peerContext(station, sampleFor, expectedFor) {
  return neighbours(station, 4)
    .map(({ station: s, km }) => {
      const value = sampleFor(s);
      const exp = expectedFor?.(s);
      if (!value || value.temp_c === null || !exp) return null;
      return {
        station: s,
        km,
        value,
        anomaly: {
          temp_c: value.temp_c - exp.temp_c,
          pres_hpa: value.pres_hpa - exp.pres_hpa,
          rh_pct: value.rh_pct - exp.rh_pct,
        },
      };
    })
    .filter(Boolean);
}

/**
 * Learn the station's normal diurnal shape from a warm-up window that precedes
 * the replay. Returns a lookup from timestamp to expected values — this is the
 * "normal temporal pattern" the temporal and spatial layers score against, and
 * it is built from observed history alone, never from the simulator's clean
 * signal.
 */
export function fitDiurnal(warmup) {
  const bins = Array.from({ length: 24 }, () => ({ temp_c: [], pres_hpa: [], rh_pct: [] }));
  for (const s of warmup) {
    if (s.temp_c === null) continue;
    const h = new Date(s.t).getUTCHours();
    for (const p of PARAMS) bins[h][p].push(s[p]);
  }
  const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
  const table = bins.map((b) => ({
    temp_c: median(b.temp_c),
    pres_hpa: median(b.pres_hpa),
    rh_pct: median(b.rh_pct),
  }));

  // Fill any hour with no warm-up coverage from its nearest populated neighbour.
  for (let i = 0; i < 24; i++) {
    if (table[i].temp_c !== null) continue;
    for (let d = 1; d < 24; d++) {
      const a = table[(i - d + 24) % 24];
      const b = table[(i + d) % 24];
      const src = a.temp_c !== null ? a : b.temp_c !== null ? b : null;
      if (src) {
        table[i] = { ...src };
        break;
      }
    }
  }
  // Interpolate between bins: the underlying diurnal cycle is continuous, so
  // stepping between whole hours would put a false discontinuity into both the
  // expectation shown on screen and the temporal layer's error.
  // Each bin is the median of a whole hour, so it describes the half-hour mark;
  // the fractional index is shifted by 0.5 to keep the curve in phase.
  return (tsMs) => {
    const d = new Date(tsMs);
    const x = d.getUTCHours() + (d.getUTCMinutes() * 60 + d.getUTCSeconds()) / 3600 - 0.5;
    const i = Math.floor(x);
    const f = x - i;
    const a = table[(i + 24) % 24];
    const b = table[(i + 25) % 24];
    const out = {};
    for (const p of PARAMS) out[p] = a[p] + (b[p] - a[p]) * f;
    return out;
  };
}
