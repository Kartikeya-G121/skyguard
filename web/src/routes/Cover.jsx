import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { motion, useInView } from "motion/react";
import Lenis from "lenis";
import SkyBackdrop from "../components/SkyBackdrop.jsx";
import Chakra from "../components/Chakra.jsx";
import BarographTrace from "../components/BarographTrace.jsx";
import StatusDot from "../components/StatusDot.jsx";
import ThemeToggle from "../components/ThemeToggle.jsx";
import { useStream } from "../lib/useStream.jsx";
import { STATIONS } from "../lib/stations.js";
import { TYPE_LABEL } from "../lib/contract.js";

const ANCHOR = "42182099999"; // Delhi Safdarjung — the reading on the cover

/** The five fault signatures, each drawn in the ink vocabulary. */
const TAXONOMY = [
  { type: "spike", n: "01", line: "A reading leaves the range its own recent history allows, then returns." },
  { type: "frozen", n: "02", line: "The sensor latches. The value stops moving while the weather does not." },
  { type: "drift", n: "03", line: "Calibration walks away slowly. Every single sample looks fine." },
  { type: "dropout", n: "04", line: "Nothing arrives. The gap itself is the observation." },
  { type: "inconsistent", n: "05", line: "Each sensor is plausible alone; together they describe impossible air." },
];

export default function Cover() {
  const { store, tick } = useStream();
  const s = store.stations[ANCHOR];
  const reading = s?.reading;
  const hour = new Date(store.epoch ?? Date.now()).getUTCHours();

  // Anything the detector is unhappy about comes to the top of the preview, so
  // the cover shows the actual state of the network rather than a fixed list.
  const flagged = STATIONS.filter((st) => store.stations[st.id]?.detection);
  const preview = [...flagged, ...STATIONS.filter((st) => !store.stations[st.id]?.detection)].slice(0, 6);

  useEffect(() => {
    // Lenis is driven from a plain rAF loop. Handing it a GSAP-style elapsed
    // time gives a multi-second first delta, which flings the page on load.
    const lenis = new Lenis({ duration: 1.05, smoothWheel: true });
    let raf = 0;
    const loop = (time) => {
      lenis.raf(time);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      lenis.destroy();
    };
  }, []);

  const localHour = (hour + store.hoursIn + 77.2 / 15) % 24;

  return (
    <div className="cover">
      <SkyBackdrop
        hour={localHour}
        humidity={reading?.rh_pct ?? 50}
        temp={reading?.temp_c ?? 25}
      />

      <div className="cover__paper" aria-hidden="true" />
      <Chakra className="cover__chakra" />

      <div className="cover__corner">
        <ThemeToggle />
      </div>

      <section className="cover__hero">
        <div className="cover__ghost" aria-hidden="true">
          <BarographTrace
            samples={s?.history?.slice(-160) ?? []}
            param="pres_hpa"
            variant="ghost"
          />
        </div>

        <div className="cover__grid">
        <div className="cover__inner">
          <motion.p
            className="eyebrow cover__eyebrow"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.15, duration: 0.6 }}
          >
            Smart India Hackathon · Automatic Weather Stations
          </motion.p>

          <motion.h1
            className="serif cover__title"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25, duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
          >
            SkyGuard
          </motion.h1>

          <motion.p
            className="cover__thesis"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.45, duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          >
            A weather station cannot tell you when it has started lying. Given only
            temperature, pressure and humidity, SkyGuard decides which readings to
            trust — and says why, in a sentence an operator can act on.
          </motion.p>

          <motion.div
            className="cover__now"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.7, duration: 0.7 }}
          >
            <Link to="/network" className="cover__cta">
              Open the network
              <span aria-hidden="true">→</span>
            </Link>
          </motion.div>
        </div>

        <motion.aside
          className="covernet"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6, duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="covernet__head">
            <span className="eyebrow">The network, right now</span>
            <span className="mono covernet__count">
              {flagged.length} of {STATIONS.length} flagged
            </span>
          </div>

          <ul className="covernet__list">
            {preview.map((st) => {
              const row = store.stations[st.id];
              const d = row?.detection;
              return (
                <li key={st.id} className={`covernet__row ${d ? "is-flagged" : ""}`}>
                  <div className="covernet__who">
                    <span className="covernet__name">{st.name}</span>
                    {/* The dot already carries the nominal case, so the second
                        line is spent on the station's own name until there is
                        something to say about it. */}
                    <span className={`covernet__state ${d ? "mono" : "deva"}`}>
                      {d ? TYPE_LABEL[d.type] : st.nameHi}
                    </span>
                  </div>
                  <div className="covernet__spark">
                    <BarographTrace
                      samples={row?.history?.slice(-40) ?? []}
                      param="temp_c"
                      variant="sparkline"
                    />
                  </div>
                  <span className="covernet__val mono">
                    {row?.reading?.temp_c == null ? "—" : row.reading.temp_c.toFixed(1)}
                    <i>°C</i>
                  </span>
                  <StatusDot state={d ? (d.severity === "high" ? "faulted" : "degraded") : "nominal"} />
                </li>
              );
            })}
          </ul>

          <p className="covernet__note">
            Simulated replay, not a live feed. Pass {store.day}, 10-minute cadence.
          </p>
        </motion.aside>
        </div>

        <div className="cover__scroll eyebrow" aria-hidden="true">
          Scroll — what a fault looks like
        </div>
      </section>

      <section className="taxonomy">
        <div className="taxonomy__head">
          <p className="eyebrow">Fault taxonomy</p>
          <h2 className="serif">
            Five ways an instrument goes wrong, and the mark each one leaves on the paper.
          </h2>
        </div>

        <ol className="taxonomy__list">
          {TAXONOMY.map((t, i) => (
            <TaxonomyRow key={t.type} item={t} index={i} tick={tick} />
          ))}
        </ol>

        <div className="taxonomy__foot">
          <Link to="/alerts" className="cover__cta">
            See what the detector has flagged
            <span aria-hidden="true">→</span>
          </Link>
        </div>
      </section>
    </div>
  );
}

function TaxonomyRow({ item, index }) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-15%" });

  return (
    <motion.li
      ref={ref}
      className="taxrow"
      initial={{ opacity: 0, y: 18 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.6, delay: index * 0.06, ease: [0.16, 1, 0.3, 1] }}
    >
      <span className="taxrow__n mono">{item.n}</span>
      <div className="taxrow__body">
        <h3 className="taxrow__title serif">{TYPE_LABEL[item.type]}</h3>
        <p className="taxrow__line">{item.line}</p>
      </div>
      <div className="taxrow__trace">
        <BarographTrace samples={signature(item.type)} param="v" variant="panel" height={72} />
      </div>
    </motion.li>
  );
}

/** A short, hand-made trace showing one fault's signature in isolation. */
function signature(type) {
  const n = 60;
  const base = (i) => 10 + Math.sin(i / 7) * 2.2 + Math.sin(i / 2.6) * 0.35;
  return Array.from({ length: n }, (_, i) => {
    let v = base(i);
    let kind = null;
    if (type === "spike" && i > 30 && i < 36) {
      v += 7 * Math.sin(((i - 30) / 6) * Math.PI);
      if (i === 33) kind = "spike";
    }
    if (type === "frozen" && i > 28) v = base(28);
    if (type === "drift") v += Math.max(0, i - 18) * 0.12;
    if (type === "dropout" && i > 30 && i < 42) v = null;
    if (type === "inconsistent" && i > 26 && i < 44) {
      v = base(i) + 3.4;
      if (i === 35) kind = "spike";
    }
    return { v, kind };
  });
}
