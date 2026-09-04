import { memo, useState } from "react";
import { ComposableMap, Geographies, Geography, Marker } from "react-simple-maps";

const INDIA_GEO =
  "https://cdn.jsdelivr.net/gh/udit-001/india-maps-data@main/geojson/india.geojson";

// nominal → green, degraded → saffron, faulted → red, offline → dim
const COLOR = {
  nominal:  "var(--green)",
  degraded: "var(--saffron)",
  faulted:  "#ef4444",
  offline:  "var(--dimmer)",
};

function stateOf(r) {
  if (!r?.reading) return "nominal";
  if (r.reading.temp_c === null) return "offline";
  if (!r.detection) return "nominal";
  return r.detection.severity === "high" ? "faulted" : "degraded";
}

function IndiaMap({ readings, selectedId, onSelect }) {
  return (
    <div style={{ background: "var(--ink)", borderRadius: 8 }}>
      <ComposableMap
        projection="geoMercator"
        projectionConfig={{ scale: 1000, center: [82, 24] }}
        style={{ width: "100%", height: "auto" }}
      >
        {/* One gradient across the whole map, not per state: the default
            objectBoundingBox units would restart it inside every path. The
            stops are mixed into --raise so the landmass stays opaque. */}
        <defs>
          <linearGradient id="india-wash" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="800" y2="600">
            <stop offset="0" stopColor="color-mix(in srgb, var(--flag-saffron) 14%, var(--raise))" />
            <stop offset="0.5" stopColor="color-mix(in srgb, var(--flag-chakra) 8%, var(--raise))" />
            <stop offset="1" stopColor="color-mix(in srgb, var(--flag-green) 12%, var(--raise))" />
          </linearGradient>
        </defs>

        <Geographies geography={INDIA_GEO}>
          {({ geographies }) =>
            geographies.map((geo) => (
              <Geography
                key={geo.rsmKey}
                geography={geo}
                style={{
                  default: { fill: "url(#india-wash)", stroke: "var(--rule-bright)", strokeWidth: 0.9, outline: "none" },
                  hover:   { fill: "var(--raise-2)", outline: "none" },
                  pressed: { fill: "var(--raise-2)", outline: "none" },
                }}
              />
            ))
          }
        </Geographies>

        {readings.map((r) => {
          const st = stateOf(r);
          const selected = r.station.id === selectedId;
          const color = COLOR[st];
          return (
            <Marker
              key={r.station.id}
              coordinates={[r.station.lon, r.station.lat]}
              onClick={() => onSelect?.(r.station.id)}
            >
              {(st === "faulted" || st === "degraded") && (
                <circle r={12} fill="none" stroke={color} strokeWidth={1.5} opacity={0.6}>
                  <animate attributeName="r" from="8" to="18" dur="1.2s" repeatCount="indefinite" />
                  <animate attributeName="opacity" from="0.6" to="0" dur="1.2s" repeatCount="indefinite" />
                </circle>
              )}
              <circle
                r={selected ? 9 : 6}
                fill={color}
                stroke="var(--bone)"
                strokeWidth={1.5}
                style={{ cursor: "pointer" }}
              />
              <text
                textAnchor="start"
                x={10}
                y={4}
                style={{ fontFamily: "var(--font-mono)", fontSize: 9, fill: "var(--dim)", pointerEvents: "none" }}
              >
                {r.station.name}
              </text>
            </Marker>
          );
        })}
      </ComposableMap>
    </div>
  );
}

export default memo(IndiaMap);
