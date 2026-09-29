import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import ThemeToggle from "./ThemeToggle.jsx";
import { useStream } from "../lib/useStream.jsx";

const NAV = [
  { to: "/network", n: "01", label: "Network", job: "Where" },
  { to: "/alerts", n: "02", label: "Alerts", job: "What changed" },
  { to: "/edge", n: "03", label: "Fleet", job: "Hardware" },
];

/**
 * Persistent frame: identity, the three network-level views, the replay clock
 * and the transport controls. Station and evidence views are reached from the
 * network and the alert feed, not from the nav — they are always about one
 * thing you picked.
 */
export default function Shell() {
  const { store, speed, setSpeed, running, setRunning, epoch, tick, skipToNextEvent, live } =
    useStream();
  const location = useLocation();
  const navigate = useNavigate();

  // On the evidence view the new incident replaces the one on screen; anywhere
  // else the current view simply catches up to the new moment in the replay.
  const skip = () => {
    const event = skipToNextEvent();
    if (event && location.pathname.startsWith("/anomaly/")) navigate(`/anomaly/${event.id}`);
  };
  const clock = new Date(epoch + store.hoursIn * 3600e3);

  return (
    <div className="shell">
      <aside className="rail">
        <NavLink to="/" className="rail__mark" aria-label="SkyGuard, back to cover">
          <span className="rail__glyph serif">S</span>
        </NavLink>

        <nav className="rail__nav">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} className="rail__link">
              <span className="rail__n mono">{item.n}</span>
              <span className="rail__label">{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="rail__foot">
          <ThemeToggle />
          <span className="rail__badge mono">SIM</span>
          {live.status === "connected" && (
            <NavLink to="/edge" className="rail__badge rail__badge--live mono" title="ESP32 connected">
              LIVE
            </NavLink>
          )}
        </div>
      </aside>

      <div className="shell__body">
        <header className="topbar">
          <div className="topbar__clock">
            <span className="eyebrow">Replay clock · UTC · pass {store.day}</span>
            <time className="mono topbar__time" dateTime={clock.toISOString()}>
              {clock.toISOString().slice(0, 16).replace("T", " ")}
            </time>
          </div>

          <div className="topbar__note">
            <span className="eyebrow">Simulated stream</span>
            <p>
              Values are synthesised from a station model with injected faults.{" "}
              {live.status === "connected"
                ? "Only the ESP32 live node reports real sensor readings."
                : "Nothing on screen is a live measurement."}
            </p>
          </div>

          <div className="transport">
            <button
              className={`transport__btn ${running ? "is-on" : ""}`}
              onClick={() => setRunning(!running)}
              aria-pressed={running}
            >
              {running ? "Pause" : "Resume"}
            </button>
            <div className="transport__speeds" role="group" aria-label="Replay speed">
              {[1, 4, 16].map((s) => (
                <button
                  key={s}
                  className={`transport__speed mono ${speed === s ? "is-on" : ""}`}
                  onClick={() => setSpeed(s)}
                  aria-pressed={speed === s}
                >
                  {s}×
                </button>
              ))}
            </div>
            <button
              className="transport__btn"
              onClick={skip}
              title="Run the replay forward until the detector opens the next incident"
            >
              Next incident →
            </button>
            <span className="transport__tick mono" aria-hidden="true">
              {String(tick % 1000).padStart(3, "0")}
            </span>
          </div>
        </header>

        <AnimatePresence mode="wait">
          <motion.main
            key={location.pathname}
            className="view"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
          >
            <Outlet />
          </motion.main>
        </AnimatePresence>
      </div>
    </div>
  );
}
