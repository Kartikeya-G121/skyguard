import { useState } from "react";
import { Link } from "react-router-dom";
import StatusDot from "./StatusDot.jsx";
import { useStream } from "../lib/useStream.jsx";
import { LIVE_STATION } from "../lib/stations.js";
import { BROKER_URL, topicFor } from "../lib/live.js";
import { TYPE_LABEL, PARAM_LABEL } from "../lib/contract.js";

const STATUS_TEXT = {
  off: "Not connected",
  connecting: "Connecting to broker…",
  connected: "Subscribed, waiting for the device",
  error: "Connection failed",
};

const fmt = (v, dp) => (v === null || v === undefined ? "—" : v.toFixed(dp));

/**
 * Connects the dashboard to an ESP32 publishing over MQTT (see `firmware/`).
 * The node joins the network as one more station and is scored by the same
 * detector, against its own calibrated baseline and its nearest neighbours.
 */
export default function LivePanel() {
  const { live, connectDevice, disconnectDevice, recalibrate, store } = useStream();
  const [draft, setDraft] = useState(live.device);
  const s = store.stations[LIVE_STATION.id];
  const on = live.status !== "off";
  const reporting = s && Date.now() - s.lastMessageAt < 7000;
  const r = s?.reading;
  const d = s?.detection;

  let state = "offline";
  if (reporting) state = d ? (d.severity === "high" ? "faulted" : "degraded") : "nominal";

  return (
    <section className="panel edge__live">
      <div className="live__head">
        <div>
          <h2 className="eyebrow">Live device · ESP32 over MQTT</h2>
          <p className="live__status">
            {s && on ? (
              <>
                <StatusDot state={state} />
                <span className="is-quiet">
                  {reporting ? `Reporting · message ${s.deviceSeq ?? "—"}` : "Silent, scored as dropout"}
                </span>
              </>
            ) : (
              <span className={live.status === "error" ? "is-anomalous" : "is-quiet"}>
                {STATUS_TEXT[live.status]}
                {live.error ? ` (${live.error})` : ""}
              </span>
            )}
          </p>
        </div>

        <form
          className="live__form"
          onSubmit={(e) => {
            e.preventDefault();
            if (on) {
              setDraft(live.device);
              disconnectDevice();
            } else connectDevice(draft.trim());
          }}
        >
          <label className="field">
            <span className="eyebrow">Device ID</span>
            <input
              className="live__input mono"
              value={on ? live.device : draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="e.g. skyguard-bmsce-01"
              disabled={on}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <button className="btn" type="submit" disabled={!on && !draft.trim()}>
            {on ? "Disconnect" : "Connect"}
          </button>
        </form>
      </div>

      {s && on ? (
        <div className="live__body">
          <dl className="live__now mono">
            <div><dt>Temperature</dt><dd>{fmt(r?.temp_c, 1)} °C</dd></div>
            <div><dt>Pressure</dt><dd>{fmt(r?.pres_hpa, 1)} hPa</dd></div>
            <div><dt>Humidity</dt><dd>{fmt(r?.rh_pct, 0)} %</dd></div>
          </dl>

          <dl className="edge__calc mono live__verdicts">
            <div>
              <dt>On-device check</dt>
              <dd className={s.edge && !s.edge.ok ? "is-anomalous" : ""}>
                {s.edge ? (s.edge.ok ? "Pass" : `Fail · ${s.edge.check}`) : "—"}
              </dd>
            </div>
            <div>
              <dt>Dashboard detector</dt>
              <dd className={d ? "is-anomalous" : ""}>
                {s.calibration
                  ? `Calibrating ${s.calibration.length}/10`
                  : d
                    ? `${TYPE_LABEL[d.type]} · ${PARAM_LABEL[d.param].toLowerCase()} · ${(d.confidence * 100).toFixed(0)}%`
                    : "Nominal"}
              </dd>
            </div>
          </dl>

          <div className="live__actions">
            <Link className="btn" to={`/station/${LIVE_STATION.id}`}>
              Open the station <span aria-hidden="true">→</span>
            </Link>
            {s.openEvent && (
              <Link className="btn" to={`/anomaly/${s.openEvent.id}`}>
                Evidence for {s.openEvent.id} <span aria-hidden="true">→</span>
              </Link>
            )}
            <button className="btn" type="button" onClick={recalibrate}>
              Recalibrate
            </button>
          </div>
        </div>
      ) : (
        <p className="reasons__note">
          Run the sketch in <code>firmware/wokwi</code> on{" "}
          <a href="https://wokwi.com/projects/new/esp32" target="_blank" rel="noreferrer">
            Wokwi
          </a>{" "}
          or a real board, then enter the same device ID here. It publishes to{" "}
          <code>{topicFor(draft.trim() || "<device>")}</code> on <code>{BROKER_URL}</code>.
        </p>
      )}

      <p className="reasons__note">
        The node has no history to learn a daily cycle from, so its normal is the median of
        its first ten samples. Recalibrate after deliberately moving a sensor to accept the
        new level. The broker is public: anyone who knows the topic can read or publish to it.
      </p>
    </section>
  );
}
