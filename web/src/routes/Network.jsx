import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import IndiaMap from "../components/IndiaMap.jsx";
import StatusDot from "../components/StatusDot.jsx";
import BarographTrace from "../components/BarographTrace.jsx";
import { useStream } from "../lib/useStream.jsx";
import { STATIONS } from "../lib/stations.js";
import { TYPE_LABEL, PARAM_LABEL } from "../lib/contract.js";

/**
 * Where. One job: show which stations in the network can be trusted right now,
 * and let the operator open the one that cannot.
 */
export default function Network() {
  const { store, tick } = useStream();
  const navigate = useNavigate();
  const [selected, setSelected] = useState(null);

  const rows = useMemo(
    () => STATIONS.map((s) => store.stations[s.id]),
    [store, tick]
  );

  const counts = rows.reduce(
    (acc, r) => {
      const st = state(r);
      acc[st] = (acc[st] ?? 0) + 1;
      return acc;
    },
    { nominal: 0, degraded: 0, faulted: 0, offline: 0 }
  );

  const sel = selected ? store.stations[selected] : null;

  return (
    <div className="net">
      <header className="view__head">
        <div>
          <p className="eyebrow">01 — Network</p>
          <h1 className="serif view__title">
            {counts.nominal} of {rows.length} stations agree with their neighbours.
          </h1>
        </div>
        <dl className="net__tally">
          {["faulted", "degraded", "offline", "nominal"].map((k) => (
            <div key={k} className="net__tallyitem">
              <dt className="eyebrow">{k}</dt>
              <dd className={`mono ${k === "faulted" || k === "degraded" ? "is-anomalous" : k === "nominal" ? "is-nominal" : "is-quiet"}`}>
                {counts[k] ?? 0}
              </dd>
            </div>
          ))}
        </dl>
      </header>

      <div className="net__grid">
        <figure className="net__map panel">
          <IndiaMap
            readings={rows}
            selectedId={selected}
            onSelect={(id) => setSelected(id === selected ? null : id)}
          />
          <figcaption className="net__caption">
            <span className="eyebrow">Station network</span>
            <p>
              Fifteen stations, coloured by what the detector currently makes of each
              one. Pick one to read its streams; a fault that moves every station at
              once is weather, a fault that moves one is the instrument.
            </p>
          </figcaption>
        </figure>

        <div className="net__side">
          {sel ? (
            <StationCard s={sel} onOpen={() => navigate(`/station/${sel.station.id}`)} />
          ) : (
            <div className="net__empty">
              <p className="eyebrow">No station selected</p>
              <p className="net__emptytext">
                Pick a station on the map, or start with one the detector is unhappy about.
              </p>
              <ul className="net__quick">
                {rows
                  .filter((r) => r.detection)
                  .slice(0, 4)
                  .map((r) => (
                    <li key={r.station.id}>
                      <button className="net__quickbtn" onClick={() => setSelected(r.station.id)}>
                        <StatusDot state={state(r)} label={false} />
                        <span>{r.station.name}</span>
                        <span className="mono is-quiet">{TYPE_LABEL[r.detection.type]}</span>
                      </button>
                    </li>
                  ))}
                {rows.filter((r) => r.detection).length === 0 && (
                  <li className="net__quietnote is-quiet">
                    Nothing flagged in this slot. Raise the replay speed to reach the
                    injected faults sooner.
                  </li>
                )}
              </ul>
            </div>
          )}

          <div className="tablewrap">
            <table className="table net__table">
              <caption className="sr-only">All stations, current slot</caption>
              <thead>
                <tr>
                  <th scope="col">Station</th>
                  <th scope="col" className="num">°C</th>
                  <th scope="col" className="num">hPa</th>
                  <th scope="col" className="num">%</th>
                  <th scope="col">State</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.station.id}
                    className={`${r.station.id === selected ? "is-selected" : ""} ${r.detection ? "is-flagged" : ""}`}
                    onClick={() => setSelected(r.station.id)}
                  >
                    <th scope="row">
                      <span>{r.station.name}</span>
                      <span className="deva table__alt">{r.station.nameHi}</span>
                    </th>
                    <td className="num mono">{fmt(r.reading?.temp_c, 1)}</td>
                    <td className="num mono">{fmt(r.reading?.pres_hpa, 1)}</td>
                    <td className="num mono">{fmt(r.reading?.rh_pct, 0)}</td>
                    <td>
                      <StatusDot state={state(r)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function StationCard({ s, onOpen }) {
  const d = s.detection;
  return (
    <motion.article
      key={s.station.id}
      className="stcard panel"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
    >
      <header className="stcard__head">
        <div>
          <h2 className="serif stcard__name">{s.station.name}</h2>
          <p className="deva stcard__alt">{s.station.nameHi}</p>
        </div>
        <StatusDot state={state(s)} />
      </header>

      <dl className="stcard__meta mono">
        <div><dt>ID</dt><dd>{s.station.id}</dd></div>
        <div><dt>Elev</dt><dd>{s.station.elev.toFixed(0)} m</dd></div>
        <div><dt>Lat/Lon</dt><dd>{s.station.lat.toFixed(2)}, {s.station.lon.toFixed(2)}</dd></div>
      </dl>

      <BarographTrace samples={s.history.slice(-96)} param="temp_c" variant="panel" height={96} />

      {d ? (
        <p className="stcard__verdict is-anomalous">
          {TYPE_LABEL[d.type]} on {PARAM_LABEL[d.param].toLowerCase()} · {(d.confidence * 100).toFixed(0)}% confidence
        </p>
      ) : (
        <p className="stcard__verdict is-nominal">All three sensors consistent with model and neighbours.</p>
      )}

      <button className="btn" onClick={onOpen}>
        Open station <span aria-hidden="true">→</span>
      </button>
    </motion.article>
  );
}

const fmt = (v, dp) => (v === null || v === undefined ? "—" : v.toFixed(dp));

function state(r) {
  if (!r?.reading) return "nominal";
  if (r.reading.temp_c === null) return "offline";
  if (!r.detection) return "nominal";
  return r.detection.severity === "high" ? "faulted" : "degraded";
}
