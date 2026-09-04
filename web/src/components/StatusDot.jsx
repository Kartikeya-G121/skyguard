const COPY = {
  nominal: "Nominal",
  degraded: "Degraded",
  faulted: "Faulted",
  offline: "Not reporting",
};

/** Sensor state. The dot is the only non-typographic status cue in the app. */
export default function StatusDot({ state, label = true }) {
  return (
    <span className={`status status--${state}`}>
      <span className="status__dot" aria-hidden="true" />
      {label && <span className="status__text">{COPY[state]}</span>}
    </span>
  );
}
