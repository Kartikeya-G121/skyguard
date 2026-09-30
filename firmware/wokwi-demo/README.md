# The demo build — for the SIH video

**Use this one to record.** It plays the whole architecture by itself in about
two minutes. Press ▶ and record; you don't have to touch anything.

## Running it in VS Code? Read this first

**You must run `PlatformIO: Build` before `Wokwi: Start Simulator`.** The
compiled firmware lives in `.pio/`, which is deliberately not in git — it is
build output and it is huge. A fresh clone therefore has no `firmware.bin`, and
the simulator will fail with a "cannot find firmware" error until you build
once. That is the single most common reason this does not start.

1. **F1** -> `Wokwi: Request a new License` (free, one per person)
2. Open **this folder** (`firmware/wokwi-demo/`) as the VS Code workspace root.
   Not the repository root, and not `firmware/wokwi/` — that one is the
   browser-only build and has no `wokwi.toml`.
3. **F1** -> `PlatformIO: Build`, and wait. The first build downloads the ESP32
   toolchain, which is roughly a gigabyte.
4. **F1** -> `Wokwi: Start Simulator`

### On Windows

Two things bite on Windows specifically:

- **Long paths.** PlatformIO builds to paths like
  `.pio\build\esp32dev\FrameworkArduino\...`, which blows past the old
  260-character limit if the repository sits somewhere deep like
  `C:\Users\you\OneDrive\Documents\GitHub\`. The build fails with
  confusing "cannot open output file" errors. Either clone to a short path such
  as `C:\dev\skyguard`, or enable long paths:
  `git config --global core.longpaths true` and turn on
  *Win32 long paths* in Group Policy.
- **Antivirus.** Real-time scanning on `.pio` makes the first build extremely
  slow. Excluding the folder helps a lot.

## Run it on wokwi.com instead (about 3 minutes, nothing to install)

1. Go to <https://wokwi.com/projects/new/esp32> — no account needed to run it.
2. Click the **`diagram.json`** tab, select all, and paste in
   [`diagram.json`](diagram.json) from this folder.
3. Click the **`sketch.ino`** tab, select all, and paste in
   [`sketch.ino`](sketch.ino).
4. Add the libraries. **Don't use the Library Manager search** — "MQTT" is a
   common word and the right one is hard to pick out. Instead click the **+**
   next to the file tabs, make a new file called exactly `libraries.txt`, and
   paste in these three lines:

   ```
   # Wokwi Library List
   MQTT@2.5.3
   DHT sensor library for ESPx
   ```

   `MQTT` is Joel Gaehwiler's arduino-mqtt. Pinning `@2.5.3` means you get that
   one and not whatever the search turns up.
5. Change `DEVICE_ID` on line 42 to something nobody else will use, e.g.
   `skyguard-bmsce-01`. The broker is public and shared.
6. Press **▶**. Watch the serial monitor at the bottom.

## What plays out

| Time | On screen | What it proves |
| --- | --- | --- |
| 0:00 | Wi-Fi → DHCP → SNTP → TLS → MQTT CONNECT → PUBACK | The normal path, end to end |
| 0:05 | `EDGE checks pass`, green TX LED blinks, blue LINK LED on | The on-device range and sanity checks from Q1 |
| 0:35 | **RUNG 2** — Wi-Fi drops, readings go out over LoRa | The station keeps reporting with no Wi-Fi |
| 1:10 | **RUNG 3** — gateway lost too, `NVS buffered depth=n/48` | Nothing is thrown away |
| 1:40 | **RECOVERY** — Wi-Fi back, one HTTPS POST drains the backlog | The outage becomes a gap that fills in |

Buttons work at any point if you want to inject a fault on camera:

- **FREEZE** (blue) — latches humidity. After ~35 s the red EDGE LED lights and
  the dashboard raises *Frozen value on humidity*.
- **DROP** (yellow) — kills the sensor, readings go `null`, the dashboard
  raises *Communication dropout*.

## Recording it with the dashboard

This is the shot worth getting — the device and the product in one frame:

1. Start `npm run dev` in `web/`, open **Fleet** (`/edge`), type the same
   `DEVICE_ID`, press **Connect**.
2. Put Wokwi on the left and the dashboard on the right.
3. Press ▶ in Wokwi and record. Readings appear on the Fleet panel within a few
   seconds; during rungs 2 and 3 the panel goes quiet, and at 1:40 the backlog
   lands.
4. Press **FREEZE** around 0:15 and the dashboard flags it with a reason and a
   suggested replacement value — that is the money shot for judging.

The dashboard subscribes over `wss://broker.hivemq.com:8884/mqtt` while the
ESP32 uses TCP; same topic, so they meet at the broker.

## What is real and what is modelled

Say this out loud in the video rather than letting someone find it:

| | |
| --- | --- |
| **Real** | Wi-Fi, DHCP, DNS, SNTP, TLS, MQTT QoS 1 with a retained last will, an HTTPS POST that gets a genuine 200, NVS writes that survive a reboot, the edge checks |
| **Modelled** | The LoRa radio only. Wokwi has no SX1278 part, so the frame is built and its airtime computed with Semtech's formula, but nothing is transmitted. Every such line is tagged `(modelled)`. |

Wokwi runs a full network stack through its IoT gateway, which is why
everything except the radio is genuine traffic.

[`firmware/cirkit/`](../cirkit/README.md) is the same ladder for real hardware,
where LoRa is an actual SX1278 and a second ESP32 is the gateway. It is the
build to point at if a judge asks "but does the LoRa part actually work?"

## Knobs

| In `sketch.ino` | Does |
| --- | --- |
| `DEMO_SCRIPT 0` | Turns off the timeline so you drive it with the buttons |
| `T_WIFI_DOWN` / `T_LORA_DOWN` / `T_WIFI_BACK` | Move the beats (ms from boot) |
| `SAMPLE_MS` | Sampling rate; 3000 fills the serial monitor at a readable pace |
| `HTTP_BATCH_URL` | Points at httpbin for the demo; swap for the FastAPI service |

## If something goes wrong

- **Nothing connects.** Wokwi's gateway is occasionally down. The sketch tries
  TLS on 8883 twice, then drops to plain 1883 by itself and says so.
- **The dashboard shows nothing.** The `DEVICE_ID` in the sketch and the one on
  the Fleet page have to match exactly, and someone else may be using the
  default.
- **`MQTT` library not found.** It is Joel Gaehwiler's "MQTT" (arduino-mqtt).
  PubSubClient won't work here — it only publishes at QoS 0, so there is no
  PUBACK for the trace to report.
- **The stuck-value check fires immediately.** Set `SIMULATE_SENSOR_NOISE` to
  `1` (it is by default). Wokwi's DHT22 returns a perfectly steady value, which
  is exactly what that check exists to catch.
