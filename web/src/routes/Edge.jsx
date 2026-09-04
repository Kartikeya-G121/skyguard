import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useStream } from "../lib/useStream.jsx";
import { STATIONS } from "../lib/stations.js";
import { TYPE_LABEL } from "../lib/contract.js";
import Meter from "../components/Meter.jsx";

/**
 * Hardware. Which layers can run on the station itself, what that costs, and
 * which sites have earned a visit.
 *
 * Every figure here is either counted from this replay or derived from stated
 * inputs. Nothing is presented as measured telemetry, because none of it is.
 */

// Layer costs are order-of-magnitude estimates from the operation counts in
// detect.js, not benchmarks. They are shown so the split can be argued with.
const LAYERS = [
  { name: "Rolling z-score and stuck-value check", where: "device", ops: "~120 float ops per sample", note: "Fixed 24-sample window over three parameters." },
  { name: "Physical consistency", where: "device", ops: "~40 float ops per sample", note: "Two exponentials for the dewpoint, then range comparisons." },
  { name: "Diurnal expectation lookup", where: "device", ops: "~10 float ops per sample", note: "24-bin table, refit upstream and pushed to the station." },
  { name: "Spatial consistency", where: "upstream", ops: "n/a on device", note: "Needs neighbouring stations' readings, so it cannot run in isolation." },
  { name: "Diurnal refit", where: "upstream", ops: "n/a on device", note: "Runs nightly over the accumulated history." },
];

// Datasheet nominals for an ESP32-WROOM-32 class module. Inputs to the
// calculation below, not observations.
const RADIO_MA = 120;
const WAKE_MA = 40;
const SLEEP_UA = 10;

export default function Edge() {
  const { store, tick } = useStream();
  const [txPerHour, setTxPerHour] = useState(6);
  const [batteryMah, setBatteryMah] = useState(2600);

  const rows = useMemo(
    () =>
      STATIONS.map((s) => {
        const st = store.stations[s.id];
        const dropouts = st.history.filter((h) => h.temp_c === null).length;
        return {
          station: s,
          seen: st.seen,
          flagged: st.flagged,
          dropouts,
          open: st.openEvent,
          lastGood: st.lastGood,
        };
      }),
    [store, tick]
  );

  const queue = rows
    .filter((r) => r.open)
    .sort((a, b) => b.open.confidence - a.open.confidence);

  // Duty cycle: a wake to sample and score, plus a radio burst on the
  // transmissions the operator has chosen per hour.
  const wakeSecPerHour = 6 * 1.2; // six 10-minute slots, ~1.2 s awake each
  const txSecPerHour = txPerHour * 2.5;
  const sleepSecPerHour = Math.max(0, 3600 - wakeSecPerHour - txSecPerHour);
  const mAhPerHour =
    (WAKE_MA * wakeSecPerHour + RADIO_MA * txSecPerHour + (SLEEP_UA / 1000) * sleepSecPerHour) / 3600;
  const days = batteryMah / mAhPerHour / 24;
  const dutyPct = ((wakeSecPerHour + txSecPerHour) / 3600) * 100;

  return (
    <div className="edge">
      <header className="view__head">
        <div>
          <p className="eyebrow">03 — Fleet</p>
          <h1 className="serif view__title">
            Three of the five layers fit on the station itself.
          </h1>
          <p className="evidence__sub">
            The cheap, always-on checks run at the sensor, so a station keeps flagging its
            own faults when the link is down. Only the comparisons that need other
            stations go upstream.
          </p>
        </div>
      </header>

      <div className="edge__grid">
        <section className="panel edge__split">
          <h2 className="eyebrow">Where each layer runs</h2>
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Layer</th>
                  <th scope="col">Runs</th>
                  <th scope="col">Cost</th>
                </tr>
              </thead>
              <tbody>
                {LAYERS.map((l) => (
                  <tr key={l.name}>
                    <th scope="row">
                      {l.name}
                      <span className="table__alt">{l.note}</span>
                    </th>
                    <td className={`is-tight ${l.where === "device" ? "is-nominal" : "is-quiet"}`}>
                      {l.where === "device" ? "On station" : "Upstream"}
                    </td>
                    <td className="mono is-quiet">{l.ops}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="reasons__note">
            Operation counts are read off the implementation in <code>detect.js</code>, not
            benchmarked on hardware.
          </p>
        </section>

        <section className="panel edge__power">
          <h2 className="eyebrow">Power budget — modelled</h2>
          <div className="edge__inputs">
            <label className="field">
              <span className="eyebrow">Transmissions per hour</span>
              <input
                type="range"
                min="1"
                max="6"
                value={txPerHour}
                onChange={(e) => setTxPerHour(Number(e.target.value))}
              />
              <span className="mono">{txPerHour}</span>
            </label>
            <label className="field">
              <span className="eyebrow">Battery capacity</span>
              <input
                type="range"
                min="1000"
                max="10000"
                step="200"
                value={batteryMah}
                onChange={(e) => setBatteryMah(Number(e.target.value))}
              />
              <span className="mono">{batteryMah} mAh</span>
            </label>
          </div>

          <dl className="edge__calc mono">
            <div><dt>Duty cycle</dt><dd>{dutyPct.toFixed(2)}%</dd></div>
            <div><dt>Average draw</dt><dd>{mAhPerHour.toFixed(3)} mAh/h</dd></div>
            <div><dt>Battery life</dt><dd>{days.toFixed(0)} days</dd></div>
          </dl>

          <p className="reasons__note">
            From datasheet nominals for an ESP32-WROOM-32 class module: {WAKE_MA} mA awake,{" "}
            {RADIO_MA} mA transmitting, {SLEEP_UA} µA in deep sleep. Six sampling wakes an
            hour at about 1.2 s each. Self-discharge, temperature derating and solar input
            are not modelled, so treat this as an upper bound.
          </p>
        </section>

        <section className="panel edge__queue">
          <h2 className="eyebrow">Maintenance queue</h2>
          {queue.length === 0 ? (
            <p className="is-quiet">Nothing outstanding. No station has an open incident.</p>
          ) : (
            <ol className="queue">
              {queue.map((r) => (
                <li key={r.station.id} className="queue__row">
                  <div>
                    <Link to={`/station/${r.station.id}`} className="queue__name">
                      {r.station.name}
                    </Link>
                    <p className="queue__what">
                      {TYPE_LABEL[r.open.type]} · open {r.open.samples} samples
                    </p>
                  </div>
                  <Meter value={r.open.confidence} state="anomalous" />
                  <Link className="queue__link mono" to={`/anomaly/${r.open.id}`}>
                    {r.open.id} →
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="panel edge__fleet">
          <h2 className="eyebrow">Link and sampling, counted this session</h2>
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Station</th>
                  <th scope="col" className="num">Samples</th>
                  <th scope="col" className="num">Flagged</th>
                  <th scope="col" className="num">Missed slots</th>
                  <th scope="col" className="num">Last clean</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.station.id} className={r.flagged ? "is-flagged" : ""}>
                    <th scope="row">{r.station.name}</th>
                    <td className="num mono">{r.seen}</td>
                    <td className={`num mono ${r.flagged ? "is-anomalous" : "is-quiet"}`}>{r.flagged}</td>
                    <td className={`num mono ${r.dropouts ? "is-anomalous" : "is-quiet"}`}>{r.dropouts}</td>
                    <td className="num mono is-quiet">
                      {r.lastGood ? new Date(r.lastGood).toISOString().slice(11, 16) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
