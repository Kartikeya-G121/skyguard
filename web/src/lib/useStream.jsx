import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { STATIONS, LIVE_STATION } from "./stations.js";
import { sampleAt } from "./simulate.js";
import { detect, fitDiurnal, peerContext } from "./detect.js";
import { connectLive, isValidDevice, DEFAULT_DEVICE } from "./live.js";

/**
 * The only place the rest of the app touches data.
 *
 * Today it advances a simulated replay clock and runs the detector in the
 * browser. Pointing it at the Python service means replacing `tick` with a
 * WebSocket or poll — the shape handed to components is the Reading contract
 * in `contract.js` either way.
 */

const StreamContext = createContext(null);

const STEP_MIN = 10; // replay cadence, minutes of simulated time per sample
const WARMUP_DAYS = 3; // history the temporal model learns from before t=0
const MAX_HISTORY = 480;
const EPOCH = Date.UTC(2026, 8, 3, 0, 0, 0);

const DEVICE_KEY = "skyguard-device";
const LIVE_CADENCE_MS = 2000; // the firmware publishes every 2 s
const LIVE_DROPOUT_MS = 7000; // three missed slots and change
const LIVE_CALIBRATION = 10; // samples the live node learns its normal from

function initialDevice() {
  try {
    return localStorage.getItem(DEVICE_KEY) || DEFAULT_DEVICE;
  } catch {
    return DEFAULT_DEVICE;
  }
}

export function StreamProvider({ children }) {
  const [speed, setSpeed] = useState(1);
  const [running, setRunning] = useState(true);
  const [tickCount, setTickCount] = useState(0);

  // Mutable stores: these change every tick and are not worth re-rendering on
  // identity, so React state carries only the tick counter.
  const store = useRef(null);
  if (store.current === null) store.current = buildStore();

  useEffect(() => {
    if (!running) return;
    const interval = Math.max(90, 900 / speed);
    const id = setInterval(() => {
      advance(store.current);
      setTickCount((n) => n + 1);
    }, interval);
    return () => clearInterval(id);
  }, [running, speed]);

  // Presenter control: run the replay forward, sample by sample, until the
  // detector opens a new event. Stepping rather than jumping keeps the history
  // and the temporal model exactly as they would be at normal speed.
  const skipToNextEvent = useCallback(() => {
    const s = store.current;
    const startSeq = s.eventSeq;
    runUntil(s, () => s.eventSeq !== startSeq, 1);
    setTickCount((n) => n + 1);
    return s.eventSeq !== startSeq ? s.events[0] : null;
  }, []);

  // The replay is deterministic, so an evidence link opened in a fresh tab can
  // be honoured by replaying forward until that event has been raised again.
  const catchUpToEvent = useCallback((seq) => {
    const s = store.current;
    if (!(seq > s.eventSeq)) return;
    runUntil(s, () => s.eventSeq >= seq, 3);
    setTickCount((n) => n + 1);
  }, []);

  // --- live ESP32 node ----------------------------------------------------
  // The device runs on wall-clock time, not the replay clock: each message is
  // scored the moment it arrives, against its neighbours' latest replay slot,
  // so pausing or skipping the replay never holds back a physical sensor.
  const [live, setLive] = useState({ device: initialDevice(), status: "off", error: null });
  const closeLive = useRef(null);

  const connectDevice = useCallback((device) => {
    closeLive.current?.();
    closeLive.current = null;
    if (!isValidDevice(device)) {
      setLive({ device, status: "error", error: "Device ID: letters, digits, - and _ only." });
      return;
    }
    try {
      localStorage.setItem(DEVICE_KEY, device);
    } catch {
      // Remembering the device is a convenience only.
    }
    setLive({ device, status: "connecting", error: null });
    closeLive.current = connectLive(device, {
      onStatus: (status, error) =>
        setLive((l) => (l.device === device ? { ...l, status, error: error ?? null } : l)),
      onSample: (sample) => {
        receiveLive(store.current, device, sample);
        setTickCount((n) => n + 1);
      },
    });
  }, []);

  const disconnectDevice = useCallback(() => {
    closeLive.current?.();
    closeLive.current = null;
    setLive((l) => ({ ...l, status: "off", error: null }));
    delete store.current.stations[LIVE_STATION.id];
    setTickCount((n) => n + 1);
  }, []);

  const recalibrate = useCallback(() => {
    const s = store.current.stations[LIVE_STATION.id];
    if (s) startCalibration(s);
    setTickCount((n) => n + 1);
  }, []);

  // A `?device=` link, or a build with VITE_LIVE_DEVICE set, connects on load.
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("device");
    const device = fromUrl || DEFAULT_DEVICE;
    if (device) connectDevice(device);
    return () => closeLive.current?.();
  }, [connectDevice]);

  // Silence is an observation too: once the device has missed a few of its
  // reporting slots, the missing samples are scored as a dropout.
  useEffect(() => {
    const id = setInterval(() => {
      const s = store.current.stations[LIVE_STATION.id];
      if (!s || !closeLive.current) return;
      const now = Date.now();
      if (now - s.lastMessageAt > LIVE_DROPOUT_MS && now - s.lastSampleAt >= LIVE_CADENCE_MS) {
        receiveLive(store.current, s.device, { temp_c: null, pres_hpa: null, rh_pct: null }, true);
        setTickCount((n) => n + 1);
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const value = useMemo(
    () => ({
      tick: tickCount,
      speed,
      setSpeed,
      running,
      setRunning,
      skipToNextEvent,
      catchUpToEvent,
      live,
      connectDevice,
      disconnectDevice,
      recalibrate,
      store: store.current,
      epoch: EPOCH,
      stepMinutes: STEP_MIN,
    }),
    [tickCount, speed, running, skipToNextEvent, catchUpToEvent, live, connectDevice, disconnectDevice, recalibrate]
  );

  return <StreamContext.Provider value={value}>{children}</StreamContext.Provider>;
}

export function useStream() {
  const ctx = useContext(StreamContext);
  if (!ctx) throw new Error("useStream must be used inside <StreamProvider>");
  return ctx;
}

/** Current reading and open event for one station. */
export function useStation(id) {
  const { store, tick } = useStream();
  return useMemo(() => store.stations[id], [store, id, tick]);
}

/** The simulated network, plus the live node once it has reported. */
export function stationList(store) {
  const live = store.stations[LIVE_STATION.id];
  return live ? [...STATIONS, LIVE_STATION] : STATIONS;
}

/** Every event, newest first. */
export function useEvents() {
  const { store, tick } = useStream();
  return useMemo(() => store.events, [store, tick]);
}

// ---------------------------------------------------------------------------

function buildStore() {
  const stations = {};
  const stepH = STEP_MIN / 60;

  for (const st of STATIONS) {
    const history = [];
    for (let h = -WARMUP_DAYS * 24; h < 0; h += stepH) {
      const s = sampleAt(st, EPOCH, h);
      history.push({ t: s.t, ...s.observed });
    }
    stations[st.id] = {
      station: st,
      history,
      expected: fitDiurnal(history),
      reading: null,
      detection: null,
      openEvent: null,
      // Running tallies used by the fleet view. Every one of these is counted
      // from this session's replay — none are preset.
      seen: 0,
      flagged: 0,
      lastGood: null,
      truth: null,
    };
  }

  return { hoursIn: 0, day: 1, stations, events: [], eventSeq: 0 };
}

/**
 * The fault schedule covers one 24-hour window, so at the end of it the replay
 * starts the same day again rather than running on into a permanently clean
 * stream. Each station's history is rebuilt from the warm-up buffer so the
 * restart does not leave a step in the trace that the detector would then read
 * as a real excursion. Events already recorded stay in the feed.
 */
function restartDay(store) {
  const stepH = STEP_MIN / 60;
  for (const st of STATIONS) {
    const s = store.stations[st.id];
    const history = [];
    for (let h = -WARMUP_DAYS * 24; h < 0; h += stepH) {
      const r = sampleAt(st, EPOCH, h);
      history.push({ t: r.t, ...r.observed });
    }
    s.history = history;
    s.reading = null;
    s.detection = null;
    s.truth = null;
    if (s.openEvent) {
      s.openEvent.closedAt = EPOCH + 24 * 3600e3;
      s.openEvent.open = false;
      s.openEvent = null;
    }
  }
  store.hoursIn = 0;
  store.day += 1;
}

/** Advance sample by sample until `done()` holds or `days` of replay have run. */
function runUntil(store, done, days) {
  const maxSteps = (days * 24 * 60) / STEP_MIN + 1;
  for (let i = 0; i < maxSteps && !done(); i++) advance(store);
}

function advance(store) {
  const stepH = STEP_MIN / 60;
  if (store.hoursIn >= 24) restartDay(store);
  const h = store.hoursIn;
  const ts = EPOCH + h * 3600e3;

  // Every station's observation for this slot, resolved before detection so
  // the spatial layer can compare stations within the same instant.
  const slot = {};
  for (const st of STATIONS) slot[st.id] = sampleAt(st, EPOCH, h);

  for (const st of STATIONS) {
    const s = store.stations[st.id];
    const { observed, truth } = slot[st.id];
    const expected = s.expected(ts);
    const peers = peerContext(
      st,
      (o) => slot[o.id].observed,
      (o) => store.stations[o.id].expected(ts)
    );

    const detection = detect(st, s.history, observed, { expected, peers });

    /** @type {import("./contract.js").Reading} */
    const reading = {
      station: st.id,
      ts: new Date(ts).toISOString(),
      temp_c: observed.temp_c,
      pres_hpa: observed.pres_hpa,
      rh_pct: observed.rh_pct,
      anomaly: detection,
    };

    s.history.push({ t: ts, ...observed });
    if (s.history.length > MAX_HISTORY) s.history.shift();
    s.reading = reading;
    s.detection = detection;
    s.expectedNow = expected;
    s.peers = peers;
    s.truth = truth;
    s.seen += 1;
    if (detection) s.flagged += 1;
    else s.lastGood = ts;

    updateEvent(store, s, detection, ts);
  }

  store.hoursIn = h + stepH;
  // The slot the live node's neighbours were last scored at.
  store.slotTs = ts;
}

// ---------------------------------------------------------------------------
// Live node

const NO_VALUES = { temp_c: null, pres_hpa: null, rh_pct: null };

/**
 * The live node has no warm-up history to learn a diurnal normal from, so it
 * learns a flat one from its first samples. Recalibrating after deliberately
 * moving a sensor is how an operator accepts the new level as normal.
 */
function startCalibration(s) {
  s.calibration = [];
  s.baseline = null;
  s.expected = () => s.baseline ?? NO_VALUES;
}

function medians(samples) {
  const out = {};
  for (const p of ["temp_c", "pres_hpa", "rh_pct"]) {
    const v = samples.map((x) => x[p]).sort((a, b) => a - b);
    out[p] = v[Math.floor(v.length / 2)];
  }
  return out;
}

/** Score one sample from the device, or a missed slot when `missed` is set. */
function receiveLive(store, device, sample, missed = false) {
  let s = store.stations[LIVE_STATION.id];
  if (!s || s.device !== device) {
    s = {
      station: LIVE_STATION,
      device,
      history: [],
      reading: null,
      detection: null,
      openEvent: null,
      seen: 0,
      flagged: 0,
      lastGood: null,
      truth: null,
      lastMessageAt: 0,
      lastSampleAt: 0,
      edge: null,
      deviceSeq: null,
    };
    startCalibration(s);
    store.stations[LIVE_STATION.id] = s;
  }

  const now = Date.now();
  s.lastSampleAt = now;
  if (!missed) {
    s.lastMessageAt = now;
    s.edge = sample.edge ?? null;
    s.deviceSeq = sample.seq ?? null;
  }

  const observed = { temp_c: sample.temp_c, pres_hpa: sample.pres_hpa, rh_pct: sample.rh_pct };
  const complete = observed.temp_c !== null && observed.pres_hpa !== null && observed.rh_pct !== null;

  // Calibration samples teach the baseline and are not scored against it.
  // Missing values are still scored: a dropout needs no baseline to be called.
  const calibrating = s.calibration !== null;
  if (calibrating && complete) {
    s.calibration.push(observed);
    s.baseline = medians(s.calibration);
    if (s.calibration.length >= LIVE_CALIBRATION) s.calibration = null;
  }

  const slotTs = store.slotTs;
  const peers =
    slotTs === undefined
      ? []
      : peerContext(
          LIVE_STATION,
          (o) => store.stations[o.id].reading,
          (o) => store.stations[o.id].expected(slotTs)
        );

  const detection =
    calibrating && complete
      ? null
      : detect(LIVE_STATION, s.history, observed, { expected: s.baseline, peers });

  s.reading = {
    station: LIVE_STATION.id,
    ts: new Date(now).toISOString(),
    ...observed,
    anomaly: detection,
  };
  s.history.push({ t: now, ...observed });
  if (s.history.length > MAX_HISTORY) s.history.shift();
  s.detection = detection;
  s.expectedNow = s.baseline ? { ...s.baseline } : null;
  s.peers = peers;
  s.seen += 1;
  if (detection) s.flagged += 1;
  else s.lastGood = now;

  updateEvent(store, s, detection, now);
}

/**
 * Consecutive detections of the same fault on the same sensor are one event,
 * not one alert per sample. A frozen humidity sensor is a single incident that
 * has been open for four hours — showing it 24 times would bury everything else.
 */
function updateEvent(store, s, detection, ts) {
  const open = s.openEvent;

  if (!detection) {
    if (open) {
      open.closedAt = ts;
      open.open = false;
      s.openEvent = null;
    }
    return;
  }

  if (open && open.type === detection.type && open.param === detection.param) {
    open.lastAt = ts;
    open.samples += 1;
    open.confidence = Math.max(open.confidence, detection.confidence);
    open.severity = detection.confidence > 0.62 ? "high" : open.severity;
    open.latest = detection;
    return;
  }

  if (open) {
    open.closedAt = ts;
    open.open = false;
  }

  const event = {
    id: `EV-${String(++store.eventSeq).padStart(4, "0")}`,
    station: s.station,
    type: detection.type,
    param: detection.param,
    severity: detection.severity,
    confidence: detection.confidence,
    openedAt: ts,
    lastAt: ts,
    closedAt: null,
    open: true,
    samples: 1,
    latest: detection,
    // The evidence view reads the onset: reasons, neighbours and the subject
    // row all have to describe the same instant or the numbers contradict
    // each other as the incident decays.
    onset: detection,
    // Snapshot of the trace around the onset, for the evidence view.
    onsetHistory: s.history.slice(-48).map((x) => ({ ...x })),
    // The neighbour comparison has to be frozen at the same instant as the
    // detection. Reading the live peers instead would show the network as it
    // is now, minutes or hours after the excursion the reasons describe.
    onsetPeers: (s.peers ?? []).map((p) => ({ ...p })),
    onsetReading: s.reading ? { ...s.reading } : null,
    onsetExpected: s.expectedNow ? { ...s.expectedNow } : null,
  };
  s.openEvent = event;
  store.events.unshift(event);
  if (store.events.length > 200) store.events.pop();
}
