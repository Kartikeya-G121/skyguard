import { memo, useEffect } from "react";
import { MapContainer, TileLayer, CircleMarker, Tooltip, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";

/**
 * The network locator, on an OpenStreetMap basemap.
 *
 * The tiles are fetched from OSM at runtime, so this view needs a network
 * connection — offline it renders the pins over an empty pane. Attribution is
 * required by the licence and is left switched on.
 *
 * The basemap is desaturated in CSS (`.netmap` in app.css) rather than being
 * swapped for a themed tile service: it has to sit under the station states,
 * and full-colour tiles compete with saffron-means-fault.
 */

// The window the network sits in. Panning is bounded to it so the map cannot
// be dragged off to somewhere the stations are not.
const BOUNDS = [
  [5.5, 66.0],
  [38.5, 99.5],
];

function stateOf(r) {
  if (!r.reading) return "nominal";
  if (r.reading.temp_c === null) return "offline";
  const d = r.detection;
  if (!d) return "nominal";
  return d.severity === "high" ? "faulted" : "degraded";
}

/** Fits the window once, after the container has its final size. */
function FitIndia() {
  const map = useMap();
  useEffect(() => {
    map.fitBounds(BOUNDS, { padding: [8, 8] });
  }, [map]);
  return null;
}

function IndiaMap({ readings, selectedId, onSelect }) {
  return (
    <MapContainer
      className="netmap"
      bounds={BOUNDS}
      maxBounds={BOUNDS}
      maxBoundsViscosity={0.8}
      minZoom={3}
      maxZoom={9}
      /* The wheel belongs to the page: trapping it inside the map means the
         reader cannot scroll past this panel. Zoom is on the buttons and on
         double-click. */
      scrollWheelZoom={false}
    >
      <FitIndia />
      <TileLayer
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        maxZoom={19}
        detectRetina
      />

      {readings.map((r) => {
        const state = stateOf(r);
        const selected = r.station.id === selectedId;
        return (
          <CircleMarker
            /* Leaflet only reapplies stroke and fill when the style changes —
               a marker's class, radius and tooltip mode are fixed at the moment
               it is created. Folding the state into the key remounts the one
               marker that changed instead of leaving it painted as it was. */
            key={`${r.station.id}-${state}-${selected}`}
            center={[r.station.lat, r.station.lon]}
            radius={selected ? 9 : 6}
            className={`pin pin--${state} ${selected ? "is-selected" : ""}`}
            eventHandlers={{ click: () => onSelect?.(r.station.id) }}
          >
            {/* Flagged stations name themselves; the rest name themselves on
                hover, so fifteen labels do not collide over the basemap. */}
            <Tooltip
              className="pin__tip"
              direction="right"
              offset={[8, 0]}
              permanent={state !== "nominal" || selected}
            >
              {r.station.name}
            </Tooltip>
          </CircleMarker>
        );
      })}
    </MapContainer>
  );
}

export default memo(IndiaMap);
