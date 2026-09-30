# SkyGuard ESP32 simulation — Cirkit Designer

The station node from box **Q1** of the technical-approach slide, built as a
circuit you can assemble and run in [Cirkit Designer](https://app.cirkitdesigner.com/project).
It reads a BME280, runs the sanity and range checks that have to pass before
anything is uploaded, and carries the reading to the cloud over whichever link
is still alive.

```
                    (1) Wi-Fi · TLS 1.2 · MQTT QoS 1
  [ node ] ─────────────────────────────────────────────► AWS IoT Core
     │  BME280 · I²C
     │                (2) LoRa 865 MHz         Wi-Fi · MQTT QoS 1
     ├──────────────────────────────► [ gateway ] ──────► AWS IoT Core
     │
     └── (3) NVS ring buffer ── HTTPS POST batch once the link returns
```

Two sketches, because rung 2 needs two radios:

| File | Board | Role |
| --- | --- | --- |
| [`node/skyguard_node.ino`](node/skyguard_node.ino) | ESP32 #1 | The weather station |
| [`gateway/skyguard_gateway.ino`](gateway/skyguard_gateway.ino) | ESP32 #2 | LoRa → MQTT relay |

[`PROTOCOLS.md`](PROTOCOLS.md) has the wire formats: topics, QoS, the will, the
LoRa frame, the batch schema, the OTA manifest.

## What you actually see when it runs

The demo is the serial monitor at **115200 baud**. Every protocol step prints
one line, so the whole stack is legible without a cloud account:

```
[   0.312] BOOT  start         SkyGuard node skyguard-bmsce-01 fw=4
[   0.418] I2C   BME280 ok     sda=21 scl=22
[   0.486] LORA  radio up      865.0625 MHz sf=9 bw=125k pwr=17dBm
[   2.140] PHY   assoc         ssid=SkyGuard-Field
[   3.902] DHCP  lease         ip=10.0.0.42 gw=10.0.0.1 rssi=-58 dBm
[   4.311] NTP   sync          pool.ntp.org utc=2026-09-30T08:14:20Z
[   4.880] TLS   handshake     mutual X.509, verifying a3k....iot.ap-south-1.amazonaws.com
[   5.204] MQTT  CONNECT       clientId=skyguard-bmsce-01-9f3a keepalive=60s lwt=skyguard/…/status
[   5.402] MQTT  CONNACK       session=clean
[   5.560] MQTT  SUBSCRIBE     skyguard/skyguard-bmsce-01/cmd qos=1
[   5.612] OTA   up to date    fw=4 latest=4
[  10.618] EDGE  checks pass   t=24.08C p=909.02hPa rh=40.2%
[  10.744] MQTT  PUBACK        qos=1 126ms 287b -> skyguard/skyguard-bmsce-01/reading
[  10.789] LINK  sample done   seq=1 via=mqtt
```

Press the WIFI button and the same sample takes the long way:

```
[  31.004] FAULT wifi cut      uplink must fall through to LoRa
[  35.610] MQTT  PUBLISH fail  rc=-3
[  35.874] LORA  TX done       865.0625 MHz sf=9 bw=125k airtime=247ms
[  36.102] LORA  ACK rx        ACK|skyguard-bmsce-01|rssi=-97 rssi=-94 dBm snr=8.2
[  36.140] LINK  sample done   seq=5 via=lora
```

Cut the gateway too and it buffers, then drains everything in one POST when
Wi-Fi comes back:

```
[  47.880] LORA  ACK timeout   no gateway in range
[  47.902] NVS   buffered      seq=8 depth=1/48
...
[ 92.118] HTTP  POST          https://api.skyguard…/batch 9 samples 2614b
[ 92.640] HTTP  drained       200 -> 0, 9 samples accepted
```

## Bill of materials

| Qty | Part | Notes |
| --- | --- | --- |
| 2 | ESP32 DevKit V1 | One node, one gateway |
| 1 | BME280 breakout | I²C, address 0x76 or 0x77 |
| 2 | SX1278 / RFM95 LoRa module | 865–867 MHz for India (Ra-02 works) |
| 3 | Push button | FREEZE, DROP, WIFI |
| 3 | LED + 220 Ω | Green TX, red alert, blue link |
| 1 | LED + 220 Ω | Gateway RX indicator |
| 2 | 100 kΩ resistor | Battery divider on the node |

## Wiring — node (ESP32 #1)

| Part | Pin | ESP32 | Why this pin |
| --- | --- | --- | --- |
| BME280 | SDA | GPIO 21 | Default I²C |
| | SCL | GPIO 22 | |
| | VCC / GND | 3V3 / GND | 3.3 V, not 5 V |
| LoRa SX1278 | SCK | GPIO 18 | VSPI |
| | MISO | GPIO 19 | |
| | MOSI | GPIO 23 | |
| | NSS / CS | GPIO 5 | |
| | RST | GPIO 14 | |
| | DIO0 | GPIO 26 | TX-done / RX-done interrupt |
| Green LED | anode | GPIO 25 | Blinks on every uplink |
| Red LED | anode | GPIO 4 | An edge check failed |
| Blue LED | anode | GPIO 13 | Lit while the Wi-Fi path is in use |
| FREEZE button | → GND | GPIO 32 | Internal pull-up |
| DROP button | → GND | GPIO 33 | |
| WIFI button | → GND | GPIO 27 | |
| Battery sense | | GPIO 35 | Input-only, behind a 2:1 divider |

GPIO 6–11 are wired to the internal flash and 12 and 15 are strapping pins, so
none of them are used here. GPIO 34–39 are input-only, which is why the
battery divider is on 35 and the buttons are not.

## Wiring — gateway (ESP32 #2)

Same LoRa pins as the node: SCK 18, MISO 19, MOSI 23, CS 5, RST 14, DIO0 26.
Plus a green LED on GPIO 25 (frame received) and a blue one on GPIO 13 (MQTT
up). No sensor, no buttons.

## Build it in Cirkit Designer

1. Open <https://app.cirkitdesigner.com/project> and start a new project.
2. Drop in **ESP32 DevKit V1**, **BME280**, **SX1278**, three buttons and three
   LEDs with 220 Ω resistors, and wire them per the node table above.
3. Add the libraries from [`libraries.txt`](libraries.txt) in the Libraries panel.
4. Paste [`node/skyguard_node.ino`](node/skyguard_node.ino) into the code editor.
5. Change `DEVICE_ID` to something unique and set `STATION_LAT` / `STATION_LON`
   / `STATION_ELEV_M` to your site. The default broker is public and shared.
6. Add the second ESP32 and its SX1278, and paste the gateway sketch into it.
7. Run, and open the serial monitor at 115200.

### What the simulator can and cannot do

Worth checking before you rely on it for a live demo: browser-based circuit
simulators generally model GPIO, I²C, SPI and serial faithfully, but **Wi-Fi,
TLS, MQTT, HTTPS and radio propagation between two boards are usually not
simulated**. I could not verify Cirkit Designer's exact coverage from here, so
confirm it yourself before demo day.

The sketches are written so this does not sink the demo:

- Every protocol step traces to Serial whether or not it completes, so the full
  architecture is visible from the serial monitor alone.
- A missing radio, a failed handshake and an unreachable broker are all handled
  paths, not crashes. The node degrades down the ladder and says which rung it
  landed on.
- With no certificates pasted in, TLS drops to an unverified connection and
  **prints that it did**, rather than quietly pretending to be secure.

If it turns out Cirkit Designer does not carry the network layer, the same node
sketch runs unchanged on real hardware, and the existing
[Wokwi project](../README.md) covers the Wi-Fi + MQTT rung of the ladder.

## Causing each fault

The node calibrates its stuck-value window over the first 12 samples, about a
minute. After that:

| Do this | What it exercises | What the dashboard raises |
| --- | --- | --- |
| Raise the BME280's temperature by 10 °C+ | Rolling z-score, upstream | Spike on temperature |
| Leave it there ~40 s | Drift monitor, upstream | Calibration drift |
| Push temperature past 55 °C | **Range check, on device** — red LED, never uploaded | — (dropped at the edge) |
| Press **FREEZE** | **Stuck-value check, on device** | Frozen value on humidity |
| Press **DROP** | Sensor read failure → `null` | Communication dropout |
| Press **WIFI** | Rung 1 fails → **LoRa** | Nothing: the reading still arrives |
| Press **WIFI**, power off the gateway | Rungs 1 and 2 fail → **NVS buffer** | Dropout, then backfill on recovery |
| Release **WIFI** | **HTTPS batch drain** | The gap fills in |
| Publish `{"cmd":"recalibrate"}` to the cmd topic | Accepts the current level as normal | — |

The last three rows are the ones worth demoing. Every other prototype shows a
station failing; this shows one that keeps its data anyway.

## Connecting it to the dashboard

The reading JSON is the same contract [`web/src/lib/live.js`](../../web/src/lib/live.js)
already parses, so no web change is needed:

1. Run the node with a unique `DEVICE_ID`.
2. Open the dashboard's **Fleet** page, type that id, press **Connect** — or go
   straight to `/edge?device=<id>`.

The browser needs the broker's WebSocket port (`wss://…:8884/mqtt` by default)
while the ESP32 uses TCP 8883; both reach the same topic.

## On real hardware

- Set `WIFI_SSID` / `WIFI_PASS`, and `SIMULATE_SENSOR_NOISE` to `0` — simulated
  sensors return perfectly steady values, which is exactly what the stuck-value
  check exists to catch.
- Paste the AWS IoT endpoint into `MQTT_HOST` and the three PEM blocks into
  `AWS_ROOT_CA`, `DEVICE_CERT` and `DEVICE_KEY`. Scope the certificate's policy
  to `skyguard/${iot:ClientId}/*`.
- Set `USE_DEEP_SLEEP` to `1` for the duty cycle the Fleet page models. The
  sequence counter and stuck-value window live in RTC memory and survive it;
  the buttons will not respond while the node is asleep.
- Replace `HTTP_BATCH_URL` and `OTA_MANIFEST_URL` with the FastAPI service's
  real endpoints and pin its certificate chain with `setCACert()` instead of
  `setInsecure()`.

## A note on MicroPython

The slide says **ESP32 · MicroPython**, and these sketches are Arduino C++,
because that is what Cirkit Designer's editor compiles. The protocol design in
[`PROTOCOLS.md`](PROTOCOLS.md) is language-neutral and ports directly
(`umqtt.robust`, `urequests`, `ntptime`, `esp32.NVS`), so either decide to say
"Arduino C++" on the slide, or treat this as the reference implementation for a
MicroPython port.
