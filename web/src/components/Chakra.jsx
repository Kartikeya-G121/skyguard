/**
 * The Ashoka chakra, drawn rather than imported: 24 spokes, a rim and a hub.
 * It sits behind the cover at a few percent opacity as a watermark, turning
 * once every four minutes — slow enough that it reads as a still image until
 * you look twice.
 */
export default function Chakra({ className = "" }) {
  const spokes = Array.from({ length: 24 }, (_, i) => (i * 360) / 24);
  return (
    <svg className={`chakra ${className}`} viewBox="-100 -100 200 200" aria-hidden="true">
      <g className="chakra__spin">
        <circle r="94" />
        <circle r="88" />
        <circle r="12" />
        {spokes.map((deg) => (
          <line key={deg} x1="0" y1="0" x2="0" y2="-88" transform={`rotate(${deg})`} />
        ))}
      </g>
    </svg>
  );
}
