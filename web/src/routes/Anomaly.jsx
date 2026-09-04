import { Link, useParams } from "react-router-dom";
import { motion } from "motion/react";
import BarographTrace from "../components/BarographTrace.jsx";
import Meter from "../components/Meter.jsx";
import { useStream } from "../lib/useStream.jsx";
import { TYPE_LABEL, PARAM_LABEL, PARAM_UNIT, LAYER_LABEL } from "../lib/contract.js";

/**
 * Why. A single detection, argued rather than asserted: what each layer saw,
 * how much it counted, what the neighbours were reporting at the same instant,
 * and what the value should have been.
 */
export default function Anomaly() {
  const { id } = useParams();
  const { store, tick } = useStream();
  const event = store.events.find((e) => e.id === id);

  if (!event) {
    return (
      <div className="view__head">
        <h1 className="serif view__title">That detection is no longer in the buffer.</h1>
        <Link className="btn" to="/alerts">Back to alerts</Link>
      </div>
    );
  }

  const s = store.stations[event.station.id];
  const d = event.onset ?? event.latest;
  const unit = PARAM_UNIT[event.param] ?? "";
  const window = s.history.slice(-96);
  void tick;

  return (
    <div className="evidence">
      <header className="view__head">
        <div>
          <p className="eyebrow">
            <Link to="/alerts" className="crumb">02 — Alerts</Link> / {event.id}
          </p>
          <h1 className="serif view__title">
            {TYPE_LABEL[event.type]} on {PARAM_LABEL[event.param].toLowerCase()} at{" "}
            {event.station.name}.
          </h1>
          <p className="evidence__sub">
            Open since {clock(event.openedAt)} UTC · {event.samples} consecutive samples ·{" "}
            {event.open ? "still open" : `closed ${clock(event.closedAt)}`}
          </p>
        </div>
        <div className="evidence__conf">
          <Meter value={event.confidence} label="Peak confidence" state="anomalous" />
          <p className="evidence__sev mono">Severity {event.severity}</p>
        </div>
      </header>

      <div className="evidence__grid">
        {/* Left: what was observed. Right: what the detector made of it and
            what to do — the action sits directly under the reasons for it. */}
        <div className="evidence__col">
          <section className="panel evidence__trace">
            <h2 className="eyebrow">{PARAM_LABEL[event.param]} · reported against learned normal</h2>
            <BarographTrace
              samples={window}
              param={event.param === "multi" ? "temp_c" : event.param}
              expected={window.map((h) => s.expected(h.t)[event.param === "multi" ? "temp_c" : event.param])}
              variant="panel"
              height={200}
              showAxis
            />
            <p className="stream__legend eyebrow">
              Solid: reported · Hairline: learned normal for this time of day
            </p>
          </section>

          <section className="panel evidence__peers">
            <h2 className="eyebrow">Neighbouring stations, at onset</h2>
            <div className="tablewrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Station</th>
                    <th scope="col" className="num">Distance</th>
                    <th scope="col" className="num">Reported</th>
                    <th scope="col" className="num">Departure from own normal</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="is-subject">
                    <th scope="row">{event.station.name} <span className="is-quiet">(this station)</span></th>
                    <td className="num mono">—</td>
                    <td className="num mono">
                      {event.onsetReading?.[key(event.param)] == null
                        ? "—"
                        : event.onsetReading[key(event.param)].toFixed(1)}{unit}
                    </td>
                    <td className="num mono is-anomalous">
                      {event.onsetExpected && event.onsetReading?.[key(event.param)] != null
                        ? signed(
                            event.onsetReading[key(event.param)] -
                              event.onsetExpected[key(event.param)]
                          )
                        : "—"}
                      {unit}
                    </td>
                  </tr>
                  {(event.onsetPeers ?? []).map((p) => (
                    <tr key={p.station.id}>
                      <th scope="row">{p.station.name}</th>
                      <td className="num mono">{p.km.toFixed(0)} km</td>
                      <td className="num mono">{p.value[key(event.param)].toFixed(1)}{unit}</td>
                      <td className="num mono">{signed(p.anomaly[key(event.param)])}{unit}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="reasons__note">
              Departures are compared, not raw values: the stations sit at different
              elevations and in different climates, so only their deviation from their own
              normal is comparable.
            </p>
          </section>

        </div>

        <div className="evidence__col">
          <section className="panel evidence__reasons">
            <h2 className="eyebrow">Why it was flagged</h2>
            <ol className="reasons">
              {d.reasons.map((r, i) => (
                <motion.li
                  key={i}
                  className="reason"
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.4, delay: 0.06 * i, ease: [0.16, 1, 0.3, 1] }}
                >
                  <div className="reason__head">
                    <span className="reason__layer eyebrow">{LAYER_LABEL[r.layer]}</span>
                    <span className="reason__pct mono">{(r.contribution * 100).toFixed(0)}%</span>
                  </div>
                  <p className="reason__detail">{r.detail}</p>
                  <div className="reason__bar">
                    <motion.i
                      initial={{ scaleX: 0 }}
                      animate={{ scaleX: r.contribution }}
                      transition={{ duration: 0.5, delay: 0.06 * i + 0.1, ease: [0.16, 1, 0.3, 1] }}
                    />
                  </div>
                </motion.li>
              ))}
            </ol>
            <p className="reasons__note">
              Contributions are each layer's share of the evidence behind the combined
              confidence, not a fixed weight. Layers that stayed silent are not listed.
            </p>
          </section>

          <section className="panel evidence__action">
            <h2 className="eyebrow">Suggested action</h2>
            {d.suggested === null ? (
              <p className="evidence__actiontext">
                No replacement value offered. {event.type === "frozen"
                  ? "A latched sensor gives no information to impute from — the reading should be withheld until the instrument is checked."
                  : "The gap should be left as a gap rather than filled."}
              </p>
            ) : (
              <>
                <p className="evidence__actiontext">
                  Replace the reported {PARAM_LABEL[event.param].toLowerCase()} with the
                  value implied by this station's own normal and its neighbours' departures.
                </p>
                <div className="swap mono">
                  <span className="swap__from is-anomalous">
                    {event.onsetReading?.[key(event.param)] == null
                      ? "—"
                      : event.onsetReading[key(event.param)].toFixed(1)}{unit}
                  </span>
                  <span className="swap__arrow" aria-hidden="true">→</span>
                  <span className="swap__to is-nominal">{d.suggested}{unit}</span>
                </div>
              </>
            )}
            <p className="evidence__maint">
              {maintenance(event)}
            </p>
            <Link className="btn" to={`/station/${event.station.id}`}>
              Open the station <span aria-hidden="true">→</span>
            </Link>
          </section>

        </div>
      </div>
    </div>
  );
}

const key = (p) => (p === "multi" ? "temp_c" : p);
const clock = (t) => (t ? new Date(t).toISOString().slice(11, 16) : "—");
const signed = (v) => (v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1));

/** Maintenance implication, stated only where the fault type implies one. */
function maintenance(event) {
  switch (event.type) {
    case "drift":
      return "Drift of this shape is a calibration problem, not a failure. Schedule a comparison against a reference instrument at the next site visit.";
    case "frozen":
      return "A latched output usually means the sensor or its interface has stopped responding. It needs a physical check; a reboot alone tends to mask it.";
    case "dropout":
      return "Gaps of this length point at the link or the power supply rather than the sensor.";
    case "inconsistent":
      return "A humidity element reading past saturation is usually wetted or iced. Check the radiation shield and the aspiration.";
    default:
      return "A short excursion that resolves on its own is worth logging, not dispatching for. Recurrence at the same site is the signal to watch.";
  }
}
