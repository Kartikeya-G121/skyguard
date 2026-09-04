/**
 * Inline proportion bar, used for confidence and for each layer's contribution
 * to a detection. Chosen over a chart because the value is a single fraction —
 * a chart would be decoration.
 */
export default function Meter({ value, label, state = "neutral", detail }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className={`meter meter--${state}`}>
      {label && (
        <div className="meter__head">
          <span className="meter__label">{label}</span>
          <span className="meter__value mono">{pct.toFixed(0)}%</span>
        </div>
      )}
      <div className="meter__track" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="meter__fill" style={{ width: `${pct}%` }} />
      </div>
      {detail && <p className="meter__detail">{detail}</p>}
    </div>
  );
}
