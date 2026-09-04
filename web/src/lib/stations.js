/**
 * Station identifiers, names, coordinates and elevations are the real records
 * from NOAA's ISD history registry (isd-history.csv), filtered to Indian
 * stations still reporting in 2025. Everything downstream of `climate` is a
 * synthetic parameterisation used to drive the simulator — it is shaped by
 * latitude, elevation and coastal exposure rather than taken from published
 * climate normals, and should not be read as climatology.
 */

/**
 * @typedef {Object} Station
 * @property {string} id      NOAA USAF+WBAN identifier
 * @property {string} name    English station name
 * @property {string} nameHi  Devanagari station name
 * @property {number} lat
 * @property {number} lon
 * @property {number} elev    metres above sea level
 * @property {"coastal"|"arid"|"humid"|"alpine"} regime
 */

/** @type {Station[]} */
export const STATIONS = [
  { id: "42182099999", name: "Delhi Safdarjung", nameHi: "दिल्ली सफदरजंग", lat: 28.585, lon: 77.206, elev: 214.9, regime: "arid" },
  { id: "42339099999", name: "Jodhpur", nameHi: "जोधपुर", lat: 26.251, lon: 73.049, elev: 218.5, regime: "arid" },
  { id: "42348099999", name: "Jaipur", nameHi: "जयपुर", lat: 26.824, lon: 75.812, elev: 385.0, regime: "arid" },
  { id: "42369099999", name: "Lucknow", nameHi: "लखनऊ", lat: 26.761, lon: 80.889, elev: 125.0, regime: "humid" },
  { id: "42027099999", name: "Srinagar", nameHi: "श्रीनगर", lat: 34.083, lon: 74.833, elev: 1587.0, regime: "alpine" },
  { id: "42705399999", name: "Leh", nameHi: "लेह", lat: 34.136, lon: 77.547, elev: 3255.9, regime: "alpine" },
  { id: "42410099999", name: "Guwahati", nameHi: "गुवाहाटी", lat: 26.106, lon: 91.586, elev: 49.4, regime: "humid" },
  { id: "42314099999", name: "Dibrugarh", nameHi: "डिब्रूगढ़", lat: 27.484, lon: 95.017, elev: 110.3, regime: "humid" },
  { id: "42667099999", name: "Bhopal", nameHi: "भोपाल", lat: 23.287, lon: 77.337, elev: 524.0, regime: "humid" },
  { id: "43057099999", name: "Mumbai Colaba", nameHi: "मुंबई कोलाबा", lat: 18.9, lon: 72.817, elev: 11.0, regime: "coastal" },
  { id: "43128099999", name: "Hyderabad Begumpet", nameHi: "हैदराबाद बेगमपेट", lat: 17.452, lon: 78.461, elev: 531.0, regime: "humid" },
  { id: "43149099999", name: "Visakhapatnam", nameHi: "विशाखापत्तनम", lat: 17.717, lon: 83.217, elev: 4.6, regime: "coastal" },
  { id: "43279099999", name: "Chennai", nameHi: "चेन्नई", lat: 12.994, lon: 80.181, elev: 15.8, regime: "coastal" },
  { id: "43295099999", name: "Bengaluru", nameHi: "बेंगलुरु", lat: 12.967, lon: 77.583, elev: 921.0, regime: "humid" },
  { id: "43333099999", name: "Port Blair", nameHi: "पोर्ट ब्लेयर", lat: 11.667, lon: 92.717, elev: 79.0, regime: "coastal" },
];

/** Synthetic climate parameters derived from position and regime. */
const REGIME = {
  coastal: { diurnal: 4.5, rh: 78, rhSwing: 12 },
  arid: { diurnal: 12.5, rh: 38, rhSwing: 26 },
  humid: { diurnal: 8.5, rh: 62, rhSwing: 22 },
  alpine: { diurnal: 11.0, rh: 48, rhSwing: 20 },
};

export function climate(station) {
  const r = REGIME[station.regime];
  // Mean temperature falls with latitude and with height (≈6.5 °C per km).
  const meanTemp = 33 - 0.32 * (station.lat - 8) - 0.0065 * station.elev;
  // Mean station pressure from the barometric formula at 15 °C.
  const meanPressure = 1013.25 * Math.pow(1 - (0.0065 * station.elev) / 288.15, 5.257);
  return { meanTemp, meanPressure, ...r };
}

export const byId = (id) => STATIONS.find((s) => s.id === id);

/** The n nearest other stations, by great-circle distance. */
export function neighbours(station, n = 3) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  return STATIONS.filter((s) => s.id !== station.id)
    .map((s) => {
      const dLat = rad(s.lat - station.lat);
      const dLon = rad(s.lon - station.lon);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(rad(station.lat)) * Math.cos(rad(s.lat)) * Math.sin(dLon / 2) ** 2;
      return { station: s, km: 2 * R * Math.asin(Math.sqrt(a)) };
    })
    .sort((a, b) => a.km - b.km)
    .slice(0, n);
}
