# SkyGuard ESP32 node

An ESP32 station that reads temperature, humidity and pressure, runs the cheap on-device checks, and
publishes each sample over MQTT. The dashboard adds it to the network as the **ESP32 live node**, a
16th station, and scores it with the same detector as the simulated ones.

```
ESP32 (Wokwi or real) ──WiFi──► broker.hivemq.com:1883 ──► broker (wss :8884) ──► SkyGuard dashboard
  DHT22 + pressure input         skyguard/<device>/reading                        subscribes, runs detector
```

## Run it in Wokwi

1. Open <https://wokwi.com/projects/new/esp32>.
2. Replace `sketch.ino` with [`wokwi/sketch.ino`](wokwi/sketch.ino), and `diagram.json` with
   [`wokwi/diagram.json`](wokwi/diagram.json).
3. In **Library Manager**, add `PubSubClient` and `DHT sensor library for ESPx`. Or create a
   `libraries.txt` tab with the contents of [`wokwi/libraries.txt`](wokwi/libraries.txt).
4. Change `DEVICE_ID` near the top of the sketch to something unique, e.g. `skyguard-bmsce-01`. The
   default broker is public and shared with everyone else using it.
5. Press ▶. The serial monitor shows `WiFi... connected`, `MQTT connected`, then one `->` line per sample.
6. In the dashboard, go to **Fleet**, enter the same device ID and press **Connect**. Or open
   `https://<your-dashboard>/edge?device=skyguard-bmsce-01` to connect on load.

The node calibrates over its first 10 samples (about 20 s). After that, try these faults:

| Do this in Wokwi | What the dashboard raises |
| --- | --- |
| Click the DHT22 and drag temperature up by 10 °C or more for a few seconds | Spike on temperature |
| Leave it there: after about 40 s the spike becomes a sustained offset | Calibration drift |
| Drag temperature above 55 °C | Cross-parameter inconsistency (and the red EDGE LED lights) |
| Turn the potentiometer sharply | Spike on pressure |
| Press **FREEZE** (blue) | Frozen value on humidity after about 25 s (the EDGE LED lights first) |
| Press **DROP** (yellow) | Communication dropout after about 7 s |

Press a button again to clear its fault. Press **Recalibrate** on the Fleet page to accept a new level as normal.

## Circuit

| Part | ESP32 pin | Role |
| --- | --- | --- |
| DHT22 | GPIO 15 | Temperature and humidity |
| Potentiometer | GPIO 34 | Stands in for a barometer, 860–960 hPa |
| FREEZE button | GPIO 18 → GND | Latches the humidity reading (a stuck sensor) |
| DROP button | GPIO 19 → GND | Stops publishing (a dead radio link) |
| Red LED + 220 Ω | GPIO 4 | An on-device check failed |
| Green LED + 220 Ω | GPIO 16 | Blinks on each publish |

## Message format

One JSON message every 2 s to `skyguard/<DEVICE_ID>/reading`. The fields follow the `Reading` contract in
`web/src/lib/contract.js`. The dashboard adds the timestamp when a message arrives and runs detection
itself.

```json
{ "temp_c": 24.08, "pres_hpa": 909.02, "rh_pct": 40.2, "seq": 17, "edge": { "ok": true, "check": null } }
```

A failed sensor read is sent as `null` for that field. `edge.check` names the on-device check that failed:
`temp_range`, `rh_range`, `pressure_range`, `stuck_temp`, `stuck_pressure`, `stuck_humidity` or `sensor_read`.

## On real hardware

- Set `WIFI_SSID` and `WIFI_PASS` to your network.
- Set `SIMULATE_SENSOR_NOISE` to `0`. Wokwi's sensors return perfectly steady values, which the
  stuck-sensor check would rightly flag, so the sketch adds a small jitter in simulation only.
- Replace the potentiometer with a real barometer, such as a BMP280 or BME280 over I²C, and set
  `STATION_ELEV_M` to the station's elevation.

## Pointing at a different broker

The dashboard uses `wss://broker.hivemq.com:8884/mqtt` by default. To use your own broker, build the
dashboard with `VITE_MQTT_URL=wss://your-broker/mqtt` and change `MQTT_HOST` / `MQTT_PORT` in the sketch.
The browser needs the broker's WebSocket port; the ESP32 uses plain TCP. For anything beyond a demo, use
a private broker with credentials.
