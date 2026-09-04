import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { motion, AnimatePresence } from "motion/react";
import BarographTrace from "../components/BarographTrace.jsx";
import { useStream } from "../lib/useStream.jsx";
import { TYPE_LABEL, PARAM_LABEL, SEVERITY_ORDER } from "../lib/contract.js";

/* Ten rows: enough to triage a slot at a glance, short enough that the pager
   stays within one screen of the header at 1440x900. */
const PER_PAGE = 10;

const FILTERS = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "high", label: "High severity" },
];

/**
 * What changed. A triage feed: one row per incident, not one per sample, so a
 * humidity sensor that has been latched for four hours reads as one problem.
 */
export default function Alerts() {
  const { store, tick } = useStream();
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);

  const events = useMemo(() => {
    const all = store.events;
    const filtered =
      filter === "open" ? all.filter((e) => e.open) : filter === "high" ? all.filter((e) => e.severity === "high") : all;
    return [...filtered].sort((a, b) => {
      if (a.open !== b.open) return a.open ? -1 : 1;
      const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      return sev !== 0 ? sev : b.openedAt - a.openedAt;
    });
  }, [store, tick, filter]);

  const open = store.events.filter((e) => e.open).length;

  // The feed is live, so the page count moves under the reader. Clamp rather
  // than reset: staying on the last page you asked for is less disorienting
  // than being thrown back to the top every time an incident closes.
  const pages = Math.max(1, Math.ceil(events.length / PER_PAGE));
  const current = Math.min(page, pages);
  const from = (current - 1) * PER_PAGE;
  const shown = events.slice(from, from + PER_PAGE);

  return (
    <div className="alerts">
      <header className="view__head">
        <div>
          <p className="eyebrow">02 — Alerts</p>
          <h1 className="serif view__title">
            {open === 0
              ? "Nothing open across the network."
              : `${open} incident${open === 1 ? "" : "s"} open across the network.`}
          </h1>
          <p className="evidence__sub">
            Consecutive detections of the same fault on the same sensor are grouped into
            one incident. {store.events.length} recorded since the replay began.
          </p>
        </div>
        <div className="alerts__filters" role="group" aria-label="Filter incidents">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={`chip ${filter === f.key ? "is-on" : ""}`}
              onClick={() => {
                setFilter(f.key);
                setPage(1);
              }}
              aria-pressed={filter === f.key}
            >
              {f.label}
            </button>
          ))}
        </div>
      </header>

      {events.length === 0 ? (
        <p className="alerts__empty is-quiet">
          No incidents match this filter yet. The injected faults begin a few simulated
          hours into the replay — raise the speed in the bar above to reach them.
        </p>
      ) : (
        <div className="tablewrap">
          <table className="table alerts__table">
            <caption className="sr-only">Detected incidents</caption>
            <thead>
              <tr>
                <th scope="col">ID</th>
                <th scope="col">Station</th>
                <th scope="col">Fault</th>
                <th scope="col">Sensor</th>
                <th scope="col">Trace at onset</th>
                <th scope="col" className="num">Conf.</th>
                <th scope="col" className="num">Opened</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              <AnimatePresence initial={false}>
                {shown.map((e) => (
                  <motion.tr
                    key={e.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.25 }}
                    className={e.severity === "high" ? "is-flagged" : ""}
                  >
                    <th scope="row" className="mono">
                      <Link to={`/anomaly/${e.id}`}>{e.id}</Link>
                    </th>
                    <td>
                      <Link to={`/station/${e.station.id}`}>{e.station.name}</Link>
                    </td>
                    <td className={e.severity === "high" ? "is-anomalous" : ""}>{TYPE_LABEL[e.type]}</td>
                    <td className="is-quiet">{PARAM_LABEL[e.param]}</td>
                    <td className="alerts__spark">
                      <BarographTrace
                        samples={e.onsetHistory}
                        param={e.param === "multi" ? "temp_c" : e.param}
                        variant="sparkline"
                      />
                    </td>
                    <td className="num mono">{(e.confidence * 100).toFixed(0)}%</td>
                    <td className="num mono">{new Date(e.openedAt).toISOString().slice(11, 16)}</td>
                    <td className="mono">
                      {e.open ? (
                        <span className="is-anomalous">open · {e.samples}</span>
                      ) : (
                        <span className="is-quiet">closed</span>
                      )}
                    </td>
                  </motion.tr>
                ))}
              </AnimatePresence>
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <nav className="pager" aria-label="Incident pages">
          <button
            className="chip"
            onClick={() => setPage(current - 1)}
            disabled={current === 1}
          >
            <span aria-hidden="true">←</span> Newer
          </button>
          <p className="pager__count mono">
            {from + 1}–{Math.min(from + PER_PAGE, events.length)} of {events.length}
            <span className="is-quiet"> · page {current} of {pages}</span>
          </p>
          <button
            className="chip"
            onClick={() => setPage(current + 1)}
            disabled={current === pages}
          >
            Older <span aria-hidden="true">→</span>
          </button>
        </nav>
      )}
    </div>
  );
}
