/**
 * The payload contract between this UI and the detection service.
 *
 * Nothing in the app reads any other shape, so pointing `useStream` at the
 * Python endpoint later is a one-file change. Field names and units match the
 * problem statement: °C, hPa, %.
 *
 * @typedef {Object} Reading
 * @property {string} station            NOAA USAF+WBAN identifier
 * @property {string} ts                 ISO 8601, UTC
 * @property {number|null} temp_c        null when the sample did not arrive
 * @property {number|null} pres_hpa
 * @property {number|null} rh_pct
 * @property {Detection|null} anomaly
 *
 * @typedef {Object} Detection
 * @property {"spike"|"frozen"|"drift"|"dropout"|"inconsistent"} type
 * @property {"temp_c"|"pres_hpa"|"rh_pct"|"multi"} param
 * @property {"low"|"medium"|"high"} severity
 * @property {number} confidence         0–1
 * @property {Reason[]} reasons          ordered by contribution, descending
 * @property {number|null} suggested     imputed replacement for `param`
 *
 * @typedef {Object} Reason
 * @property {"statistical"|"temporal"|"physical"|"spatial"} layer
 * @property {string} detail             one sentence, written for an operator
 * @property {number} contribution       0–1, sums to ~1 across reasons
 */

export const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

export const TYPE_LABEL = {
  spike: "Spike",
  frozen: "Frozen value",
  drift: "Calibration drift",
  dropout: "Communication dropout",
  inconsistent: "Cross-parameter inconsistency",
};

export const PARAM_LABEL = {
  temp_c: "Temperature",
  pres_hpa: "Pressure",
  rh_pct: "Humidity",
  multi: "Multiple parameters",
};

export const PARAM_UNIT = { temp_c: "°C", pres_hpa: "hPa", rh_pct: "%" };

export const LAYER_LABEL = {
  statistical: "Statistical",
  temporal: "Temporal model",
  physical: "Physical consistency",
  spatial: "Spatial consistency",
};
