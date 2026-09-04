import { STATIONS, climate } from "./stations.js";
import { relativeHumidity, dewpoint } from "./physics.js";

/**
 * Synthetic AWS signal generator with injected faults.
 *
 * Two things are produced for every sample: the value a healthy sensor would
 * have reported (`clean`) and the value the faulty sensor actually reported
 * (`observed`). The detector never sees `clean` — it is kept only so the
 * demo can score detections against ground truth.
 */

const HOUR = 3600e3;
const DAY = 24 * HOUR;

/** Deterministic hash-based noise so a given station and time always agree. */
function noise(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/** Local solar time offset, in hours, from longitude. */
const solarOffset = (lon) => lon / 15;

/** Healthy signal for one station at one instant. */
export function cleanSample(station, t) {
  const c = climate(station);
  const hours = t / HOUR + solarOffset(station.lon);
  const dayOfYear = (t % (365.25 * DAY)) / DAY;

  // Seasonal swing, weakest near the equator.
  const seasonal = Math.cos(((dayOfYear - 195) / 365.25) * 2 * Math.PI) * (station.lat * 0.28);
  // Diurnal cycle, peaking around 15:00 local.
  const diurnal = -Math.cos(((hours - 15) / 24) * 2 * Math.PI) * (c.diurnal / 2);
  // Slow synoptic wander shared by temperature and pressure. The phase varies
  // smoothly with position, so a passing system moves neighbouring stations
  // together — that regional coherence is exactly what the spatial layer
  // relies on to tell a real weather event from a single failing sensor.
  const phase = t / (2.4 * DAY) + station.lon / 22 + station.lat / 30;
  const synoptic = Math.sin(phase) * 1.8;

  const temp_c = c.meanTemp + seasonal + diurnal + synoptic + noise(t / 6e5 + station.lat) * 0.22;

  // Semidiurnal atmospheric tide (~1 hPa) plus the same synoptic term.
  const tide = Math.sin(((hours - 10) / 12) * 2 * Math.PI) * 1.05;
  const pres_hpa = c.meanPressure + tide + synoptic * 1.4 + noise(t / 9e5 + station.lon) * 0.12;

  // Humidity tracks temperature inversely: the dewpoint is far steadier than
  // the temperature, so RH is derived from it rather than modelled directly.
  const dewBase = dewpoint(c.meanTemp, c.rh) + seasonal * 0.55 + synoptic * 0.6;
  const rh_pct = Math.min(99.2, Math.max(4, relativeHumidity(temp_c, dewBase)));

  return { temp_c, pres_hpa, rh_pct };
}

/**
 * Fault schedule. Fixed per station so a demo run is reproducible: the same
 * fault appears at the same point in the replay every time.
 *
 * `at` and `until` are offsets in hours from the start of the replay window.
 */
export const FAULTS = {
  "42339099999": { kind: "spike", param: "temp_c", at: 5.5, until: 6.4, magnitude: 22 },
  "42410099999": { kind: "frozen", param: "rh_pct", at: 3.0, until: 24 },
  "42027099999": { kind: "drift", param: "pres_hpa", at: 0, until: 24, rate: 0.55 },
  "43333099999": { kind: "dropout", param: "all", at: 8.0, until: 9.6 },
  "42667099999": { kind: "inconsistent", param: "rh_pct", at: 11.0, until: 12.2 },
  "43149099999": { kind: "spike", param: "pres_hpa", at: 16.0, until: 16.3, magnitude: -14 },
};

/**
 * Apply the scheduled fault, if any is active. Returns the observed sample
 * and the ground-truth label.
 */
export function applyFault(station, clean, hoursIn, epochMs) {
  const f = FAULTS[station.id];
  const observed = { ...clean };
  if (!f || hoursIn < f.at || hoursIn > f.until) return { observed, truth: null };

  const progress = (hoursIn - f.at) / Math.max(f.until - f.at, 1e-6);

  switch (f.kind) {
    case "spike": {
      // A short excursion with a fast rise and a slower decay, as a failing
      // thermistor or a pressure transducer glitch actually behaves.
      const shape = Math.sin(Math.pow(progress, 0.45) * Math.PI);
      observed[f.param] = clean[f.param] + f.magnitude * shape;
      if (f.param === "temp_c") {
        // The humidity sensor keeps reporting the true moisture content, so
        // the pair becomes physically impossible — that is the tell.
        observed.rh_pct = clean.rh_pct;
      }
      break;
    }
    case "frozen": {
      // Latches at whatever it read the instant the fault began.
      observed[f.param] = cleanSample(station, epochMs + f.at * HOUR)[f.param];
      break;
    }
    case "drift": {
      // Slow calibration walk: undetectable sample by sample, obvious against
      // neighbouring stations after a few hours.
      observed[f.param] = clean[f.param] + f.rate * (hoursIn - f.at);
      break;
    }
    case "dropout": {
      observed.temp_c = null;
      observed.pres_hpa = null;
      observed.rh_pct = null;
      break;
    }
    case "inconsistent": {
      // Wetted or iced humidity sensor: reads past saturation.
      observed.rh_pct = 100 + 4.5 * Math.sin(progress * Math.PI);
      break;
    }
  }
  return { observed, truth: { type: f.kind, param: f.param } };
}

/** Full observed sample for one station at one replay hour. */
export function sampleAt(station, epochMs, hoursIn) {
  const t = epochMs + hoursIn * HOUR;
  const clean = cleanSample(station, t);
  const { observed, truth } = applyFault(station, clean, hoursIn, epochMs);
  return { t, clean, observed, truth };
}

export const ALL_STATIONS = STATIONS;
