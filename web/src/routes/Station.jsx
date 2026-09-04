import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { motion } from "motion/react";
import BarographTrace from "../components/BarographTrace.jsx";
import Reading from "../components/Reading.jsx";
import StatusDot from "../components/StatusDot.jsx";
import Meter from "../components/Meter.jsx";
import { useStream } from "../lib/useStream.jsx";
import { dewpoint } from "../lib/physics.js";
import { TYPE_LABEL, PARAM_LABEL, PARAM_UNIT } from "../lib/contract.js";

const STREAMS = [
  { param: "temp_c", label: "Temperature", unit: "°C" },
  { param: "pres_hpa", label: "Pressure", unit: "hPa" },
  { param: "rh_pct", label: "Humidity", unit: "%" },
];

/**
 * What. One station, its three streams against the model's expectation, and
 * the health of each sensor. Nothing about the wider network lives here.
 */
export default function Station() {
  const { id } = useParams();
  const { store, tick } = useStream();
  const s = store.stations[id];

  const window = useMemo(() => (s ? s.history.slice(-144) : []), [s, tick]);
  const expectedSeries = useMemo(
    () =>
      s
        ? Object.fromEntries(
            STREAMS.map(({ param }) => [param, window.map((h) => s.expected(h.t)[param])])
          )
        : {},
    [s, window]
  );

  if (!s) {
    return (
      <div className="view__head">
        <h1 className="serif view__title">No such station.</h1>
        <Link className="btn" to="/network">Back to the network</Link>
      </div>
    );
  }

  const r = s.reading;
  const d = s.detection;
  const offline = r?.temp_c === null;
  const td = r && !offline ? dewpoint(r.temp_c, r.rh_pct) : null;
  const spread = td === null ? null : r.temp_c - td;

  return (
    <div className="station">
      <header className="view__head">
        <div>
          <p className="eyebrow">
            <Link to="/network" className="crumb">01 — Network</Link> / Station {s.station.id}
          </p>
          <h1 className="serif view__title">{s.station.name}</h1>
          <p className="deva view__alt">{s.station.nameHi}</p>
        </div>

        <div className="station__now">
          {STREAMS.map(({ param, label, unit }) => (
            <Reading
              key={param}
              value={r?.[param]}
              unit={unit}
              label={label}
              state={d?.param === param ? "anomalous" : offline ? "muted" : "nominal"}
            />
          ))}
        </div>
      </header>

      <div className="station__grid">
        <section className="station__streams">
          {STREAMS.map(({ param, label, unit }, i) => {
            const flagged = d?.param === param || d?.param === "multi";
            return (
              <motion.figure
                key={param}
                className={`stream panel ${flagged ? "is-flagged" : ""}`}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: i * 0.08, ease: [0.16, 1, 0.3, 1] }}
              >
                <figcaption className="stream__head">
                  <span className="eyebrow">{label} · {unit}</span>
                  <span className="stream__range mono">
                    {range(window, param)}
                  </span>
                </figcaption>
                <BarographTrace
                  samples={window}
                  param={param}
                  expected={expectedSeries[param]}
                  variant="panel"
                  height={128}
                  showAxis
                  marks={[1]}
                />
                <p className="stream__legend eyebrow">
                  Solid: reported · Hairline: learned normal for this time of day
                </p>
              </motion.figure>
            );
          })}
        </section>

        <aside className="station__side">
          <section className="panel station__health">
            <h2 className="eyebrow">Sensor health · this slot</h2>
            <ul className="health">
              {STREAMS.map(({ param, label }) => {
                const st = sensorState(s, param);
                return (
                  <li key={param} className="health__row">
                    <span className="health__name">{label}</span>
                    <StatusDot state={st} />
                  </li>
                );
              })}
            </ul>
            <dl className="health__stats mono">
              <div>
                <dt>Samples this session</dt>
                <dd>{s.seen}</dd>
              </div>
              <div>
                <dt>Slots flagged this session</dt>
                <dd className={s.flagged ? "is-anomalous" : ""}>{s.flagged}</dd>
              </div>
              <div>
                <dt>Last clean slot</dt>
                <dd>{s.lastGood ? new Date(s.lastGood).toISOString().slice(11, 16) : "—"}</dd>
              </div>
            </dl>
          </section>

          <section className="panel station__psych">
            <h2 className="eyebrow">Temperature and dewpoint</h2>
            {spread === null ? (
              <p className="is-quiet">Not reporting.</p>
            ) : (
              <>
                <div className="psych">
                  <div className="psych__scale">
                    <span className="psych__tick psych__tick--td mono" style={{ left: `${pct(td)}%` }}>
                      <i />Td {td.toFixed(1)}°C
                    </span>
                    <span className="psych__tick psych__tick--t mono" style={{ left: `${pct(r.temp_c)}%` }}>
                      <i />T {r.temp_c.toFixed(1)}°C
                    </span>
                  </div>
                </div>
                <p className="psych__note">
                  {spread < 0
                    ? "Dewpoint above air temperature — physically impossible, so at least one of the two sensors is wrong."
                    : `Air is ${spread.toFixed(1)}°C above its dewpoint. The two sensors have to converge, never cross.`}
                </p>
              </>
            )}
          </section>

          {d && (
            <motion.section
              className="panel station__flag"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            >
              <h2 className="eyebrow is-anomalous">Open detection</h2>
              <p className="station__flagtype serif">
                {TYPE_LABEL[d.type]} · {PARAM_LABEL[d.param]}
              </p>
              <Meter value={d.confidence} label="Confidence" state="anomalous" />
              {d.suggested !== null && (
                <p className="station__suggest mono">
                  Suggested replacement {d.suggested}
                  {PARAM_UNIT[d.param] ?? ""}
                </p>
              )}
              {s.openEvent && (
                <Link className="btn" to={`/anomaly/${s.openEvent.id}`}>
                  Open the evidence <span aria-hidden="true">→</span>
                </Link>
              )}
            </motion.section>
          )}
        </aside>
      </div>
    </div>
  );
}

function range(window, param) {
  const vals = window.map((w) => w[param]).filter((v) => v !== null && v !== undefined);
  if (!vals.length) return "—";
  const dp = param === "rh_pct" ? 0 : 1;
  return `${Math.min(...vals).toFixed(dp)} – ${Math.max(...vals).toFixed(dp)}`;
}

/** Per-sensor state: only the sensor named in the detection is faulted. */
function sensorState(s, param) {
  if (s.reading?.temp_c === null) return "offline";
  const d = s.detection;
  if (!d) return "nominal";
  if (d.param === param || d.param === "multi") {
    return d.severity === "high" ? "faulted" : "degraded";
  }
  return "nominal";
}

const pct = (v) => Math.max(2, Math.min(98, ((v + 10) / 60) * 100));
