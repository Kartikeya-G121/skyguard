/**
 * A single instrument reading. Typographic — figure, unit, label — with no
 * icon and no invented delta. The only colour it can take is the state colour.
 */
export default function Reading({ value, unit, label, state = "nominal", size = "md", sub }) {
  const missing = value === null || value === undefined;
  return (
    <figure className={`reading reading--${size} reading--${state}`}>
      <div className="reading__value mono">
        {missing ? <span className="reading__missing">—</span> : format(value, unit)}
        {!missing && <span className="reading__unit">{unit}</span>}
      </div>
      <figcaption className="reading__label eyebrow">{label}</figcaption>
      {sub && <div className="reading__sub mono">{sub}</div>}
    </figure>
  );
}

function format(v, unit) {
  if (unit === "hPa") return v.toFixed(1);
  if (unit === "%") return v.toFixed(0);
  return v.toFixed(1);
}
