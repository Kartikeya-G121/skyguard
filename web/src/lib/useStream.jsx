import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { STATIONS } from "./stations.js";
import { sampleAt } from "./simulate.js";
import { detect, fitDiurnal, peerContext } from "./detect.js";

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

  const value = useMemo(
    () => ({
      tick: tickCount,
      speed,
      setSpeed,
      running,
      setRunning,
      store: store.current,
      epoch: EPOCH,
      stepMinutes: STEP_MIN,
    }),
    [tickCount, speed, running]
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
