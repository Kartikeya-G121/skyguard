/**
 * Thermodynamic relationships used by the consistency layer.
 *
 * NOAA global-hourly reports temperature and dewpoint rather than relative
 * humidity, so RH is derived. That makes the T/Td relationship the physical
 * basis of the humidity checks below, not an arbitrary threshold.
 */

// Magnus-Tetens coefficients over water (Alduchov & Eskridge, 1996).
const A = 17.625;
const B = 243.04;

/** Dewpoint (°C) from air temperature (°C) and relative humidity (%). */
export function dewpoint(tempC, rhPct) {
  const rh = Math.min(Math.max(rhPct, 0.5), 100) / 100;
  const gamma = Math.log(rh) + (A * tempC) / (B + tempC);
  return (B * gamma) / (A - gamma);
}

/** Relative humidity (%) from air temperature and dewpoint, both °C. */
export function relativeHumidity(tempC, dewC) {
  const e = Math.exp((A * dewC) / (B + dewC) - (A * tempC) / (B + tempC));
  return e * 100;
}

/** Saturation vapour pressure (hPa) over water. */
export function saturationVapourPressure(tempC) {
  return 6.1094 * Math.exp((A * tempC) / (B + tempC));
}

/**
 * Sea-level-reduced pressure (hPa) from station pressure, using the
 * barometric formula with a standard lapse rate. Used to compare stations
 * that sit at different elevations.
 */
export function toSeaLevel(pressureHpa, elevationM, tempC) {
  const tK = tempC + 273.15;
  return pressureHpa * Math.pow(1 - (0.0065 * elevationM) / (tK + 0.0065 * elevationM), -5.257);
}

/**
 * Physical plausibility checks across the three parameters. Each returns a
 * violation object or null. These are deterministic and cheap — they run on
 * every sample ahead of any model, and they are what makes a fault
 * *explainable* rather than merely improbable.
 */
export function plausibility({ temp_c, pres_hpa, rh_pct }, elevationM = 0) {
  const out = [];

  if (rh_pct > 100.5) {
    out.push({
      check: "rh_range",
      detail: `Relative humidity ${rh_pct.toFixed(1)}% exceeds saturation`,
      severity: "high",
    });
  }
  if (rh_pct < 0) {
    out.push({ check: "rh_range", detail: "Relative humidity below zero", severity: "high" });
  }
  if (temp_c < -60 || temp_c > 55) {
    out.push({
      check: "temp_range",
      detail: `Temperature ${temp_c.toFixed(1)}°C outside the observed terrestrial range`,
      severity: "high",
    });
  }
  // The 870–1085 hPa record range applies to sea-level pressure. A station at
  // 3,256 m legitimately reports around 680 hPa, so reduce before comparing.
  const slp = toSeaLevel(pres_hpa, elevationM, temp_c);
  if (slp < 870 || slp > 1085) {
    out.push({
      check: "pressure_range",
      detail: `Pressure ${pres_hpa.toFixed(1)} hPa reduces to ${slp.toFixed(1)} hPa at sea level, outside the recorded global range`,
      severity: "high",
    });
  }

  const td = dewpoint(temp_c, rh_pct);
  if (td > temp_c + 0.5) {
    out.push({
      check: "dewpoint_exceeds_temp",
      detail: `Dewpoint ${td.toFixed(1)}°C above air temperature ${temp_c.toFixed(1)}°C`,
      severity: "high",
    });
  }

  // Hot and saturated at once is physically possible but vanishingly rare on
  // land; it is the classic signature of the 55 °C sensor fault in the brief.
  if (temp_c > 45 && rh_pct > 80) {
    out.push({
      check: "wet_bulb_implausible",
      detail: `${temp_c.toFixed(1)}°C at ${rh_pct.toFixed(0)}% RH implies an unsurvivable wet-bulb temperature`,
      severity: "high",
    });
  }

  return out;
}

/** Rolling standard deviation of the last n values. */
export function stdev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(v);
}

/** Robust z-score against a rolling window, using the median and MAD. */
export function robustZ(value, window) {
  if (window.length < 4) return 0;
  const sorted = [...window].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const deviations = window.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = deviations[Math.floor(deviations.length / 2)] || 1e-6;
  return (value - median) / (1.4826 * mad);
}
