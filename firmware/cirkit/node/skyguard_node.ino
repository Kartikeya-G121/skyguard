/*
 * SkyGuard station node — the ESP32 edge device of an Automatic Weather Station.
 *
 * Built to be assembled in Cirkit Designer (app.cirkitdesigner.com). This is
 * the device in box Q1 of the technical-approach slide: it reads temperature,
 * pressure and humidity from a BME280, runs the sanity and range checks that
 * have to pass before anything is uploaded, and then gets the reading to the
 * SkyGuard cloud over whichever link is still alive.
 *
 * The uplink is a ladder, tried in order, and it is the point of the demo:
 *
 *   1. Wi-Fi  -> TLS 1.2 -> MQTT QoS 1 to AWS IoT Core       the normal path
 *   2. LoRa 865 MHz -> gateway -> the same MQTT topic        no Wi-Fi at site
 *   3. NVS ring buffer -> HTTPS POST batch once Wi-Fi is back  no link at all
 *
 * Every protocol step prints one line to Serial at 115200, so the whole stack
 * is legible in the simulator's serial monitor with no cloud account and no
 * radio. PROTOCOLS.md has the wire formats; README.md has the wiring.
 *
 * The published JSON is the same `Reading` contract the dashboard already
 * parses in web/src/lib/live.js, so a node built here shows up on the Fleet
 * page next to the fifteen simulated stations without changing the web app.
 */

#include <Wire.h>
#include <SPI.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <Update.h>
#include <time.h>
#include <stdarg.h>
#include <esp_sleep.h>

#include <Adafruit_BME280.h>
#include <LoRa.h>
#include <MQTT.h>

// ---- identity and site ----------------------------------------------------

// Must match the Device ID typed on the dashboard's Fleet page.
#define DEVICE_ID "skyguard-bmsce-01"

// Q1 of the slide ingests lat/lon with every reading: the spatial k-NN layer
// upstream needs to know which five stations are this one's neighbours.
const float STATION_LAT = 12.9416;
const float STATION_LON = 77.5656;
const float STATION_ELEV_M = 920.0;  // metres, for the sea-level reduction

// ---- network --------------------------------------------------------------

const char *WIFI_SSID = "Wokwi-GUEST";  // any open AP the simulator provides
const char *WIFI_PASS = "";

// AWS IoT Core. The endpoint is per-account: AWS IoT console -> Settings.
const char *MQTT_HOST = "broker.hivemq.com";
const uint16_t MQTT_PORT = 8883;  // 8883 mutual-TLS; 1883 only for a demo broker
const uint16_t MQTT_KEEPALIVE_S = 60;

// The HTTPS drain endpoint, served by the FastAPI service on the slide.
const char *HTTP_BATCH_URL = "https://api.skyguard.example/v1/ingest/batch";

// SNTP. IST is UTC+5:30, but everything on the wire is UTC.
const char *NTP_POOL = "pool.ntp.org";

// OTA. A JSON manifest naming the newest build and where its binary lives.
const char *OTA_MANIFEST_URL = "https://api.skyguard.example/v1/firmware/latest.json";
const uint32_t FW_VERSION = 4;

/*
 * Mutual TLS to AWS IoT Core needs three PEM blocks: Amazon's root CA, and
 * the certificate and private key of this thing. Paste them between the
 * markers. Leaving them empty drops to an unverified connection, which is the
 * only thing a browser-based simulator can actually complete.
 */
const char AWS_ROOT_CA[] = R"EOF()EOF";
const char DEVICE_CERT[] = R"EOF()EOF";
const char DEVICE_KEY[]  = R"EOF()EOF";

// ---- radio ----------------------------------------------------------------

// 865.0-867.0 MHz is the licence-free ISM band in India. SF9/BW125 gives a
// few kilometres in open country at about 250 ms of airtime per frame.
const long LORA_FREQ_HZ = 865062500;
const int LORA_SF = 9;
const long LORA_BW_HZ = 125000;
const int LORA_TX_DBM = 17;
const uint8_t LORA_SYNC_WORD = 0x53;  // 'S', so foreign traffic is ignored

// ---- pins (see README.md for the Cirkit Designer wiring table) ------------

const int PIN_SDA = 21;   // BME280
const int PIN_SCL = 22;

const int PIN_LORA_SCK = 18;  // SX1278 / RFM95 on VSPI
const int PIN_LORA_MISO = 19;
const int PIN_LORA_MOSI = 23;
const int PIN_LORA_CS = 5;
const int PIN_LORA_RST = 14;
const int PIN_LORA_DIO0 = 26;

const int PIN_LED_TX = 25;     // green, blinks on every uplink
const int PIN_LED_ALERT = 4;   // red, an edge check failed
const int PIN_LED_LINK = 13;   // blue, lit while the Wi-Fi path is the one in use

const int PIN_BTN_FREEZE = 32;  // latch humidity: a stuck sensor element
const int PIN_BTN_DROP = 33;    // stop sampling: a dead sensor bus
const int PIN_BTN_WIFI = 27;    // pull the Wi-Fi down: forces the LoRa path
const int PIN_BATTERY = 35;     // input-only, behind a 2:1 divider

// ---- tunables -------------------------------------------------------------

const uint32_t SAMPLE_MS = 5000;
const uint32_t OTA_CHECK_MS = 300000;
const int STUCK_WINDOW = 12;
const int RING_CAPACITY = 48;  // samples held in NVS while the link is down

// The Fleet page models a duty cycle; this implements it. Off by default so
// the demo stays interactive, because a sleeping node cannot see a button.
#define USE_DEEP_SLEEP 0

// Simulated sensors return a perfectly steady value, which is exactly what the
// stuck-value check exists to catch. Set to 0 on real hardware.
#define SIMULATE_SENSOR_NOISE 1

// ---------------------------------------------------------------------------

Adafruit_BME280 bme;
WiFiClientSecure tls;
MQTTClient mqtt(768);
Preferences nvs;

const char *TOPIC_READING = "skyguard/" DEVICE_ID "/reading";
const char *TOPIC_STATUS  = "skyguard/" DEVICE_ID "/status";
const char *TOPIC_CMD     = "skyguard/" DEVICE_ID "/cmd";

// Survives deep sleep, so the stuck-value window and the sequence counter are
// not thrown away every duty cycle.
RTC_DATA_ATTR uint32_t seq = 0;
RTC_DATA_ATTR float histT[STUCK_WINDOW], histP[STUCK_WINDOW], histH[STUCK_WINDOW];
RTC_DATA_ATTR int histCount = 0, histPos = 0;

enum Uplink { UP_NONE, UP_MQTT, UP_LORA, UP_BUFFER, UP_HTTP };
const char *UPLINK_NAME[] = { "none", "mqtt", "lora", "buffer", "http" };

bool frozen = false, dropped = false, wifiCut = false;
float frozenH = NAN;
bool haveBme = false, haveLora = false, clockSet = false;
uint32_t lastSample = 0, lastOtaCheck = 0;

struct Sample {
  uint32_t ts;  // unix seconds, 0 when the clock had not been set
  float t, p, h;
  uint32_t seq;
  char check[16];  // "" when every edge check passed
};

// ---- protocol trace -------------------------------------------------------

/*
 * One line per protocol event, which is what makes this a demo you can read:
 *
 *   [  12.910] NTP   sync          pool.ntp.org offset=+0.42s
 *   [  13.644] TLS   handshake     TLS1.2 verified peer=AWS IoT Core
 *   [  13.702] MQTT  CONNECT       keepalive=60s lwt=skyguard/.../status
 */
void trace(const char *proto, const char *event, const char *fmt = nullptr, ...) {
  char detail[160] = "";
  if (fmt) {
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(detail, sizeof detail, fmt, ap);
    va_end(ap);
  }
  Serial.printf("[%8.3f] %-5s %-13s %s\n", millis() / 1000.0, proto, event, detail);
}

// ---- sensing --------------------------------------------------------------

float jitter(float amplitude) {
#if SIMULATE_SENSOR_NOISE
  return amplitude * (random(-1000, 1001) / 1000.0);
#else
  return 0;
#endif
}

float seaLevel(float hpa) {
  return hpa * pow(1.0 - 0.0065 * STATION_ELEV_M / 288.15, -5.257);
}

float dewpoint(float t, float rh) {
  float g = log(max(rh, 0.1f) / 100.0) + (17.625 * t) / (243.04 + t);
  return 243.04 * g / (17.625 - g);
}

float stdev(const float *v, int n) {
  float mean = 0;
  for (int i = 0; i < n; i++) mean += v[i];
  mean /= n;
  float acc = 0;
  for (int i = 0; i < n; i++) acc += (v[i] - mean) * (v[i] - mean);
  return sqrt(acc / n);
}

/*
 * The two checks the slide puts on the device: a range check against the
 * physical limits of each instrument, and a sanity check that the three
 * readings are consistent with each other. Returns the failing check's name,
 * or nullptr when the reading is fit to upload.
 *
 * This is deliberately the cheap half of detection. The z-score, the k-NN
 * neighbour comparison and the LSTM autoencoder all need context this device
 * does not have, so they stay upstream.
 */
const char *edgeCheck(float t, float p, float h) {
  if (isnan(t) || isnan(p) || isnan(h)) return "sensor_read";

  // Range: the widest values either instrument can legitimately report.
  if (t < -60 || t > 55) return "temp_range";
  if (h < 0 || h > 100.5) return "rh_range";
  float slp = seaLevel(p);
  if (slp < 870 || slp > 1085) return "pressure_range";

  // Sanity: the dewpoint cannot be warmer than the air it condenses out of.
  if (dewpoint(t, h) > t + 0.5) return "dewpoint_over_temp";

  histT[histPos] = t;
  histP[histPos] = p;
  histH[histPos] = h;
  histPos = (histPos + 1) % STUCK_WINDOW;
  if (histCount < STUCK_WINDOW) histCount++;
  if (histCount == STUCK_WINDOW) {
    if (stdev(histT, STUCK_WINDOW) < 0.05) return "stuck_temp";
    if (stdev(histP, STUCK_WINDOW) < 0.02) return "stuck_pressure";
    if (stdev(histH, STUCK_WINDOW) < 0.05) return "stuck_humidity";
  }
  return nullptr;
}

float batteryVolts() {
  return analogRead(PIN_BATTERY) * (3.3 / 4095.0) * 2.0;  // 2:1 divider
}

// ---- store and forward ----------------------------------------------------

/*
 * A ring buffer in NVS, so a reading survives both a flat link and a reboot.
 * The slide's pitch is that no observation is lost; this is where that is
 * either true or not. NVS wear is the reason for a ring rather than a log.
 */
void ringPush(const Sample &s) {
  nvs.begin("skyguard", false);
  int head = nvs.getInt("head", 0);
  int count = nvs.getInt("count", 0);
  char key[8];
  snprintf(key, sizeof key, "s%d", head);
  nvs.putBytes(key, &s, sizeof s);
  nvs.putInt("head", (head + 1) % RING_CAPACITY);
  nvs.putInt("count", min(count + 1, RING_CAPACITY));
  nvs.end();
  trace("NVS", "buffered", "seq=%lu depth=%d/%d", (unsigned long)s.seq,
        min(count + 1, RING_CAPACITY), RING_CAPACITY);
}

int ringDepth() {
  nvs.begin("skyguard", true);
  int count = nvs.getInt("count", 0);
  nvs.end();
  return count;
}

/* Reads the buffer oldest-first without consuming it; ringClear() commits. */
int ringRead(Sample *out, int maxOut) {
  nvs.begin("skyguard", true);
  int head = nvs.getInt("head", 0);
  int count = min(nvs.getInt("count", 0), maxOut);
  for (int i = 0; i < count; i++) {
    int idx = (head - count + i + RING_CAPACITY) % RING_CAPACITY;
    char key[8];
    snprintf(key, sizeof key, "s%d", idx);
    nvs.getBytes(key, &out[i], sizeof(Sample));
  }
  nvs.end();
  return count;
}

void ringClear() {
  nvs.begin("skyguard", false);
  nvs.putInt("count", 0);
  nvs.end();
}

// ---- payload --------------------------------------------------------------

/*
 * The `Reading` contract from web/src/lib/contract.js, plus the fields this
 * device knows and the simulated stations do not. The dashboard ignores what
 * it does not recognise, so adding to this stays backward compatible.
 */
size_t buildJson(char *buf, size_t len, const Sample &s, Uplink via, int rssi) {
  char t[24], p[24], h[24], when[32];
  if (isnan(s.t)) strcpy(t, "null");
  else snprintf(t, sizeof t, "%.2f", s.t);
  if (isnan(s.p)) strcpy(p, "null");
  else snprintf(p, sizeof p, "%.2f", s.p);
  if (isnan(s.h)) strcpy(h, "null");
  else snprintf(h, sizeof h, "%.1f", s.h);

  if (s.ts) {
    time_t secs = s.ts;
    struct tm tm;
    gmtime_r(&secs, &tm);
    strftime(when, sizeof when, "\"%Y-%m-%dT%H:%M:%SZ\"", &tm);
  } else {
    strcpy(when, "null");  // the node never reached an NTP server
  }

  return snprintf(
      buf, len,
      "{\"device\":\"%s\",\"ts\":%s,\"temp_c\":%s,\"pres_hpa\":%s,\"rh_pct\":%s,"
      "\"lat\":%.4f,\"lon\":%.4f,\"elev_m\":%.0f,\"seq\":%lu,"
      "\"edge\":{\"ok\":%s,\"check\":%s%s%s},"
      "\"link\":{\"via\":\"%s\",\"rssi\":%d},\"batt_v\":%.2f,\"fw\":%lu}",
      DEVICE_ID, when, t, p, h, STATION_LAT, STATION_LON, STATION_ELEV_M,
      (unsigned long)s.seq, s.check[0] ? "false" : "true",
      s.check[0] ? "\"" : "", s.check[0] ? s.check : "null", s.check[0] ? "\"" : "",
      UPLINK_NAME[via], rssi, batteryVolts(), (unsigned long)FW_VERSION);
}

// ---- Wi-Fi, NTP, TLS, MQTT ------------------------------------------------

bool wifiUp() { return !wifiCut && WiFi.status() == WL_CONNECTED; }

void wifiConnect() {
  if (wifiCut || WiFi.status() == WL_CONNECTED) return;
  trace("PHY", "assoc", "ssid=%s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS, 6);  // fixed channel skips the scan
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 12000) delay(200);
  if (WiFi.status() == WL_CONNECTED) {
    trace("DHCP", "lease", "ip=%s gw=%s rssi=%d dBm", WiFi.localIP().toString().c_str(),
          WiFi.gatewayIP().toString().c_str(), WiFi.RSSI());
  } else {
    trace("PHY", "assoc failed", "falling back to LoRa");
  }
}

/*
 * Without a real clock the node cannot say when a reading was taken, and a
 * reading TimescaleDB cannot place on a timeline is not much use. The device
 * stamps its own samples rather than letting the broker do it, so a buffered
 * sample keeps the time it was actually measured.
 */
void syncClock() {
  if (clockSet || !wifiUp()) return;
  configTime(0, 0, NTP_POOL);  // UTC on the wire; display is the dashboard's job
  struct tm tm;
  if (getLocalTime(&tm, 8000)) {
    clockSet = true;
    char iso[32];
    strftime(iso, sizeof iso, "%Y-%m-%dT%H:%M:%SZ", &tm);
    trace("NTP", "sync", "%s utc=%s", NTP_POOL, iso);
  } else {
    trace("NTP", "sync failed", "timestamps will be null until it succeeds");
  }
}

void onCommand(String &topic, String &payload) {
  trace("MQTT", "PUBLISH rx", "%s %s", topic.c_str(), payload.c_str());
  if (payload.indexOf("recalibrate") >= 0) {
    histCount = 0;
    histPos = 0;
    trace("EDGE", "recalibrate", "stuck-value window cleared");
  }
  if (payload.indexOf("ota") >= 0) lastOtaCheck = 0;
}

bool mqttConnect() {
  if (mqtt.connected()) return true;
  if (!wifiUp()) return false;

  if (strlen(AWS_ROOT_CA) > 32) {
    tls.setCACert(AWS_ROOT_CA);
    tls.setCertificate(DEVICE_CERT);
    tls.setPrivateKey(DEVICE_KEY);
    trace("TLS", "handshake", "mutual X.509, verifying %s", MQTT_HOST);
  } else {
    // No certificates pasted in. Browser-based simulators cannot complete a
    // mutual-TLS handshake anyway, so the demo runs unverified and says so.
    tls.setInsecure();
    trace("TLS", "handshake", "UNVERIFIED (no certs) peer=%s:%u", MQTT_HOST, MQTT_PORT);
  }

  mqtt.begin(MQTT_HOST, MQTT_PORT, tls);
  mqtt.setKeepAlive(MQTT_KEEPALIVE_S);
  mqtt.onMessage(onCommand);

  /*
   * The last will is how a dropout becomes an event instead of a silence. If
   * this node stops answering PINGREQ the broker publishes "offline" on its
   * behalf, retained, so the dashboard sees the station go down within a
   * keepalive rather than waiting for samples that never arrive.
   */
  mqtt.setWill(TOPIC_STATUS, "{\"state\":\"offline\"}", true, 1);

  char clientId[64];
  snprintf(clientId, sizeof clientId, "%s-%04x", DEVICE_ID, (unsigned)random(0xffff));
  trace("MQTT", "CONNECT", "clientId=%s keepalive=%us lwt=%s", clientId,
        (unsigned)MQTT_KEEPALIVE_S, TOPIC_STATUS);

  if (!mqtt.connect(clientId)) {
    trace("MQTT", "CONNACK fail", "rc=%d, will retry", mqtt.lastError());
    return false;
  }
  trace("MQTT", "CONNACK", "session=clean");

  // Retained, so a dashboard that connects later still learns the node is up.
  mqtt.publish(TOPIC_STATUS, "{\"state\":\"online\"}", true, 1);
  mqtt.subscribe(TOPIC_CMD, 1);
  trace("MQTT", "SUBSCRIBE", "%s qos=1", TOPIC_CMD);
  return true;
}

/* QoS 1: publish() blocks until the broker's PUBACK, or reports the failure. */
bool publishMqtt(const char *json) {
  if (!mqttConnect()) return false;
  uint32_t t0 = millis();
  bool ok = mqtt.publish(TOPIC_READING, json, false, 1);
  if (ok) trace("MQTT", "PUBACK", "qos=1 %ums %ub -> %s", (unsigned)(millis() - t0), (unsigned)strlen(json),
        TOPIC_READING);
  else trace("MQTT", "PUBLISH fail", "rc=%d", mqtt.lastError());
  return ok;
}

// ---- LoRa backhaul --------------------------------------------------------

/*
 * The second rung. Most AWS sites worth instrumenting have no Wi-Fi, so the
 * node talks to a gateway a few kilometres away and the gateway does the
 * MQTT. The frame is the same JSON with a one-line header, because a text
 * frame is debuggable and a 250-byte airtime budget can carry it.
 */
bool sendLora(const char *json) {
  if (!haveLora) return false;
  if (!LoRa.beginPacket()) {
    trace("LORA", "tx busy", "channel not free");
    return false;
  }
  LoRa.print("SG1|" DEVICE_ID "|");
  LoRa.print(json);
  uint32_t t0 = millis();
  bool ok = LoRa.endPacket();  // blocks for the duration of the transmission
  trace("LORA", ok ? "TX done" : "TX fail", "%.4f MHz sf=%d bw=%ldk airtime=%ums",
        LORA_FREQ_HZ / 1e6, LORA_SF, LORA_BW_HZ / 1000, (unsigned)(millis() - t0));

  // A gateway that heard the frame answers with the sequence number. Without
  // an ack the node must assume the frame was lost and buffer it.
  LoRa.receive();
  while (millis() - t0 < 1200) {
    if (LoRa.parsePacket()) {
      String ack = LoRa.readString();
      trace("LORA", "ACK rx", "%s rssi=%d dBm snr=%.1f", ack.c_str(),
            LoRa.packetRssi(), LoRa.packetSnr());
      return true;
    }
    delay(10);
  }
  trace("LORA", "ACK timeout", "no gateway in range");
  return false;
}

// ---- HTTPS drain ----------------------------------------------------------

/*
 * The third rung, and the one that makes a dropout a recovery rather than a
 * hole. Everything buffered while the link was down goes up in one POST, so
 * the cost is a single TLS handshake however deep the backlog is.
 */
void drainOverHttps() {
  int depth = ringDepth();
  if (depth == 0 || !wifiUp()) return;

  Sample *batch = (Sample *)malloc(sizeof(Sample) * depth);
  if (!batch) return;
  int n = ringRead(batch, depth);

  String body = "{\"device\":\"" DEVICE_ID "\",\"samples\":[";
  char one[420];
  for (int i = 0; i < n; i++) {
    buildJson(one, sizeof one, batch[i], UP_HTTP, 0);
    if (i) body += ",";
    body += one;
  }
  body += "]}";
  free(batch);

  tls.setInsecure();  // swap for setCACert() once the API's chain is pinned
  HTTPClient http;
  trace("HTTP", "POST", "%s %d samples %ub", HTTP_BATCH_URL, n, (unsigned)body.length());
  http.begin(tls, HTTP_BATCH_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Id", DEVICE_ID);
  int code = http.POST(body);

  // Only a 2xx clears the buffer. Anything else and the samples stay put and
  // go again next time, which is the whole point of storing them.
  if (code >= 200 && code < 300) {
    ringClear();
    trace("HTTP", "drained", "%d, %d samples accepted, buffer empty", code, n);
  } else {
    trace("HTTP", "POST failed", "%d, keeping %d samples buffered", code, n);
  }
  http.end();
}

// ---- OTA ------------------------------------------------------------------

/*
 * The MLOps loop on the slide retrains the model and promotes a new version;
 * this is how the promoted build reaches the fleet. The manifest is checked
 * over HTTPS and the image is streamed straight into the inactive partition,
 * since it does not fit in RAM.
 */
void checkOta() {
  if (!wifiUp()) return;
  tls.setInsecure();
  HTTPClient http;
  http.begin(tls, OTA_MANIFEST_URL);
  int code = http.GET();
  if (code != 200) {
    trace("OTA", "manifest", "%d, staying on fw=%lu", code, (unsigned long)FW_VERSION);
    http.end();
    return;
  }
  String manifest = http.getString();
  http.end();

  int at = manifest.indexOf("\"version\":");
  uint32_t latest = at < 0 ? FW_VERSION : manifest.substring(at + 10).toInt();
  if (latest <= FW_VERSION) {
    trace("OTA", "up to date", "fw=%lu latest=%lu", (unsigned long)FW_VERSION, (unsigned long)latest);
    return;
  }

  int u = manifest.indexOf("\"url\":\"");
  if (u < 0) return;
  String url = manifest.substring(u + 7, manifest.indexOf('"', u + 7));
  trace("OTA", "update", "fw=%lu -> %lu from %s", (unsigned long)FW_VERSION,
        (unsigned long)latest, url.c_str());

  http.begin(tls, url);
  if (http.GET() != 200) { http.end(); return; }
  int size = http.getSize();
  if (!Update.begin(size)) { http.end(); return; }
  size_t written = Update.writeStream(*http.getStreamPtr());
  http.end();

  if (Update.end(true) && written == (size_t)size) {
    trace("OTA", "flashed", "%u bytes verified, rebooting", (unsigned)written);
    mqtt.publish(TOPIC_STATUS, "{\"state\":\"updating\"}", true, 1);
    delay(200);
    ESP.restart();
  } else {
    trace("OTA", "failed", "err=%u, keeping fw=%lu", (unsigned)Update.getError(), (unsigned long)FW_VERSION);
  }
}

// ---- buttons --------------------------------------------------------------

bool pressed(int pin, uint32_t &lastAt) {
  if (digitalRead(pin) == LOW && millis() - lastAt > 300) {
    lastAt = millis();
    return true;
  }
  return false;
}

void readButtons() {
  static uint32_t fAt = 0, dAt = 0, wAt = 0;
  if (pressed(PIN_BTN_FREEZE, fAt)) {
    frozen = !frozen;
    trace("FAULT", frozen ? "freeze on" : "freeze off", "humidity element latched");
  }
  if (pressed(PIN_BTN_DROP, dAt)) {
    dropped = !dropped;
    trace("FAULT", dropped ? "drop on" : "drop off", "sensor bus dead");
  }
  if (pressed(PIN_BTN_WIFI, wAt)) {
    wifiCut = !wifiCut;
    if (wifiCut) {
      mqtt.disconnect();
      WiFi.disconnect(true);
      trace("FAULT", "wifi cut", "uplink must fall through to LoRa");
    } else {
      trace("FAULT", "wifi restored", "");
    }
  }
}

// ---- main -----------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  trace("BOOT", "start", "SkyGuard node %s fw=%lu", DEVICE_ID, (unsigned long)FW_VERSION);

  pinMode(PIN_BTN_FREEZE, INPUT_PULLUP);
  pinMode(PIN_BTN_DROP, INPUT_PULLUP);
  pinMode(PIN_BTN_WIFI, INPUT_PULLUP);
  pinMode(PIN_LED_TX, OUTPUT);
  pinMode(PIN_LED_ALERT, OUTPUT);
  pinMode(PIN_LED_LINK, OUTPUT);
  analogReadResolution(12);
  randomSeed(esp_random());

  Wire.begin(PIN_SDA, PIN_SCL);
  haveBme = bme.begin(0x76) || bme.begin(0x77);
  trace("I2C", haveBme ? "BME280 ok" : "BME280 missing", "sda=%d scl=%d", PIN_SDA, PIN_SCL);
  if (haveBme) {
    // Weather-station preset: one oversampled reading at a time, radio off in
    // between, which is what the power budget on the Fleet page assumes.
    bme.setSampling(Adafruit_BME280::MODE_FORCED, Adafruit_BME280::SAMPLING_X1,
                    Adafruit_BME280::SAMPLING_X1, Adafruit_BME280::SAMPLING_X1,
                    Adafruit_BME280::FILTER_OFF);
  }

  SPI.begin(PIN_LORA_SCK, PIN_LORA_MISO, PIN_LORA_MOSI, PIN_LORA_CS);
  LoRa.setPins(PIN_LORA_CS, PIN_LORA_RST, PIN_LORA_DIO0);
  haveLora = LoRa.begin(LORA_FREQ_HZ);
  if (haveLora) {
    LoRa.setSpreadingFactor(LORA_SF);
    LoRa.setSignalBandwidth(LORA_BW_HZ);
    LoRa.setTxPower(LORA_TX_DBM);
    LoRa.setSyncWord(LORA_SYNC_WORD);
    LoRa.enableCrc();
    trace("LORA", "radio up", "%.4f MHz sf=%d bw=%ldk pwr=%ddBm", LORA_FREQ_HZ / 1e6,
          LORA_SF, LORA_BW_HZ / 1000, LORA_TX_DBM);
  } else {
    trace("LORA", "radio missing", "check SPI wiring; falling back to buffer");
  }

  int backlog = ringDepth();
  if (backlog) trace("NVS", "backlog", "%d samples held from the last session", backlog);

  wifiConnect();
  syncClock();
  mqttConnect();
  checkOta();
  lastOtaCheck = millis();
}

void loop() {
  readButtons();
  if (mqtt.connected()) mqtt.loop();
  digitalWrite(PIN_LED_LINK, wifiUp() && mqtt.connected());

  if (millis() - lastOtaCheck > OTA_CHECK_MS) {
    lastOtaCheck = millis();
    checkOta();
  }

  if (millis() - lastSample < SAMPLE_MS) return;
  lastSample = millis();

  // --- read ---------------------------------------------------------------
  Sample s;
  s.seq = ++seq;
  s.ts = clockSet ? (uint32_t)time(nullptr) : 0;
  s.check[0] = 0;

  if (dropped || !haveBme) {
    s.t = s.p = s.h = NAN;
  } else {
    bme.takeForcedMeasurement();
    s.t = bme.readTemperature() + jitter(0.15);
    s.p = bme.readPressure() / 100.0 + jitter(0.10);
    s.h = bme.readHumidity() + jitter(0.40);
  }

  // A latched sensor is usually one element: humidity stops updating while
  // temperature and pressure carry on, which is what makes it hard to spot.
  if (frozen && !isnan(s.h)) {
    if (isnan(frozenH)) frozenH = s.h;
    s.h = frozenH;
  } else if (!frozen) {
    frozenH = NAN;
  }

  const char *failed = edgeCheck(s.t, s.p, s.h);
  if (failed) strncpy(s.check, failed, sizeof s.check - 1);
  digitalWrite(PIN_LED_ALERT, failed ? HIGH : LOW);
  trace("EDGE", failed ? "check failed" : "checks pass",
        "t=%.2fC p=%.2fhPa rh=%.1f%%%s%s", s.t, s.p, s.h, failed ? " -> " : "",
        failed ? failed : "");

  // --- the uplink ladder --------------------------------------------------
  char json[420];
  Uplink via = UP_NONE;

  buildJson(json, sizeof json, s, UP_MQTT, WiFi.RSSI());
  if (publishMqtt(json)) {
    via = UP_MQTT;
  } else {
    buildJson(json, sizeof json, s, UP_LORA, 0);
    if (sendLora(json)) {
      via = UP_LORA;
    } else {
      ringPush(s);
      via = UP_BUFFER;
    }
  }

  digitalWrite(PIN_LED_TX, HIGH);
  delay(40);
  digitalWrite(PIN_LED_TX, LOW);
  trace("LINK", "sample done", "seq=%lu via=%s", (unsigned long)s.seq, UPLINK_NAME[via]);

  // Whatever the link did this cycle, anything still held gets a chance to go.
  if (via == UP_MQTT) drainOverHttps();

  // The duty cycle the Fleet page models: sleep between samples, wake on a
  // timer or on the FREEZE button, and keep the counters in RTC memory.
#if USE_DEEP_SLEEP
  trace("PWR", "deep sleep", "%lums, wake on timer or GPIO%d", (unsigned long)SAMPLE_MS, PIN_BTN_FREEZE);
  mqtt.disconnect();
  esp_sleep_enable_timer_wakeup((uint64_t)SAMPLE_MS * 1000ULL);
  esp_sleep_enable_ext0_wakeup((gpio_num_t)PIN_BTN_FREEZE, 0);
  esp_deep_sleep_start();
#endif
}
