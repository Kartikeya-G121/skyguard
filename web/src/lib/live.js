/**
 * MQTT link to a physical (or Wokwi-simulated) ESP32 station.
 *
 * The device publishes one JSON message per sample to
 * `skyguard/<device>/reading`. The body is the `Reading` contract without the
 * `anomaly` field, since detection runs here rather than on the device:
 *
 *   { "temp_c": 24.1, "pres_hpa": 908.6, "rh_pct": 41.8, "seq": 17,
 *     "edge": { "ok": true, "check": null } }
 *
 * `edge` is the result of the cheap checks the firmware runs on the device
 * itself. The browser's detector does not read it; it is shown next to the
 * browser's own verdict so the two can be compared.
 *
 * The broker is a public one by default. Anyone who knows the topic can read
 * or publish to it, which is acceptable for a demo and not for anything else.
 */

export const BROKER_URL = import.meta.env.VITE_MQTT_URL || "wss://broker.hivemq.com:8884/mqtt";

export const DEFAULT_DEVICE = import.meta.env.VITE_LIVE_DEVICE || "";

export const topicFor = (device) => `skyguard/${device}/reading`;

export const isValidDevice = (device) => /^[A-Za-z0-9_-]{1,40}$/.test(device);

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Parse one message body; null when it is not a usable sample. */
export function parseSample(payload) {
  let body;
  try {
    body = JSON.parse(typeof payload === "string" ? payload : new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const sample = {
    temp_c: num(body.temp_c),
    pres_hpa: num(body.pres_hpa),
    rh_pct: num(body.rh_pct),
    seq: num(body.seq),
    edge: body.edge && typeof body.edge === "object"
      ? { ok: body.edge.ok !== false, check: typeof body.edge.check === "string" ? body.edge.check : null }
      : null,
  };
  // A message with no readings at all is noise, not a sample. A message with
  // some readings missing is a sensor that failed to read, and is kept so the
  // detector can call it.
  if (sample.temp_c === null && sample.pres_hpa === null && sample.rh_pct === null) return null;
  return sample;
}

/**
 * Connect and subscribe. `onStatus` receives "connecting" | "connected" |
 * "error" | "off"; `onSample` receives parsed samples. Returns a function that
 * closes the connection.
 */
export function connectLive(device, { onStatus, onSample }) {
  let client = null;
  let closed = false;
  onStatus("connecting");

  // Loaded on demand so the simulated-only demo never downloads the MQTT client.
  import("mqtt")
    .then((mod) => {
      if (closed) return;
      const connect = mod.connect ?? mod.default?.connect;
      client = connect(BROKER_URL, {
        clientId: `skyguard-web-${Math.random().toString(16).slice(2, 10)}`,
        clean: true,
        reconnectPeriod: 3000,
        connectTimeout: 8000,
      });
      client.on("connect", () => {
        client.subscribe(topicFor(device), { qos: 0 }, (err) => {
          onStatus(err ? "error" : "connected", err?.message);
        });
      });
      client.on("reconnect", () => onStatus("connecting"));
      client.on("error", (err) => onStatus("error", err?.message));
      client.on("message", (_topic, payload) => {
        const sample = parseSample(payload);
        if (sample) onSample(sample);
      });
    })
    .catch((err) => onStatus("error", err?.message));

  return () => {
    closed = true;
    client?.end(true);
    onStatus("off");
  };
}
