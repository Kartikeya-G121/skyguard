/*
 * SkyGuard — the demo build, for the SIH video.
 *
 * One ESP32 that plays the whole architecture from the technical-approach
 * slide on its own, start to finish, in about two minutes. Press play and
 * record: no buttons need pressing, though FREEZE and DROP still work if you
 * want to inject a sensor fault on camera.
 *
 * The script the node walks through:
 *
 *   0:00  Wi-Fi -> SNTP -> TLS -> MQTT QoS 1 to the broker     rung 1, normal
 *   0:35  the Wi-Fi link "fails"; readings go out over LoRa    rung 2
 *   1:10  the gateway goes out of range; readings buffer to NVS rung 3
 *   1:40  Wi-Fi returns: reconnect, then drain the backlog over HTTPS
 *
 * What is real here and what is modelled, because the video should not claim
 * more than it does:
 *
 *   REAL     Wi-Fi association, DHCP, DNS, SNTP, TLS, MQTT QoS 1 with a last
 *            will, an HTTPS POST that gets a genuine 200, NVS writes that
 *            survive a reboot, and the on-device edge checks.
 *   MODELLED The LoRa radio. Wokwi has no SX1278 part, so the frame is built
 *            for real and its airtime is computed with Semtech's formula, but
 *            nothing is transmitted. Every such line is tagged (modelled).
 *
 * firmware/cirkit/ has the same ladder written for real hardware, where the
 * LoRa rung is an actual radio.
 */

#include <stdarg.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <time.h>
#include <MQTT.h>
#include "DHTesp.h"

// ---- configuration --------------------------------------------------------

// Change this before recording: the broker is public and shared with everyone.
#define DEVICE_ID "skyguard-demo"

const char *WIFI_SSID = "Wokwi-GUEST";
const char *WIFI_PASS = "";
const char *MQTT_HOST = "broker.hivemq.com";
const uint16_t MQTT_PORT_TLS = 8883;
const uint16_t MQTT_PORT_PLAIN = 1883;

// httpbin answers a real POST with a real 200, so rung 3 completes on camera.
// Point this at the FastAPI service once it exists.
const char *HTTP_BATCH_URL = "https://httpbin.org/post";
const char *OTA_MANIFEST_URL = "https://httpbin.org/json";
const char *NTP_POOL = "pool.ntp.org";

const float STATION_LAT = 12.9416, STATION_LON = 77.5656, STATION_ELEV_M = 920.0;
const uint32_t FW_VERSION = 4;
const uint32_t SAMPLE_MS = 3000;

// LoRa parameters, used to compute a truthful airtime for the modelled frame.
const float LORA_MHZ = 865.0625;  // India's licence-free 865-867 MHz ISM band
const int LORA_SF = 9, LORA_CR = 1;
const long LORA_BW_HZ = 125000;

// Set to 0 to drive the ladder yourself with the buttons instead.
#define DEMO_SCRIPT 1
// Measured from the FIRST DELIVERED READING, not from boot: the Wi-Fi and TLS
// handshakes take as long as they take, and the story should not start until
// the normal path has actually been shown working.
const uint32_t T_WIFI_DOWN = 30000, T_LORA_DOWN = 60000, T_WIFI_BACK = 90000;

#define SIMULATE_SENSOR_NOISE 1

// ---- pins (the diagram.json beside this file) -----------------------------

const int PIN_DHT = 15, PIN_PRESSURE = 34;
const int PIN_BTN_FREEZE = 18, PIN_BTN_DROP = 19;
const int PIN_LED_ALERT = 4, PIN_LED_TX = 16, PIN_LED_LINK = 17;

// ---------------------------------------------------------------------------

DHTesp dht;
WiFiClientSecure tlsNet;   // MQTT owns this one and nothing else may touch it
WiFiClientSecure httpNet;  // HTTPClient gets its own, or it tears MQTT's socket down
WiFiClient plainNet;
MQTTClient mqtt(768);
Preferences nvs;

const char *TOPIC_READING = "skyguard/" DEVICE_ID "/reading";
const char *TOPIC_STATUS  = "skyguard/" DEVICE_ID "/status";

enum Uplink { UP_NONE, UP_MQTT, UP_LORA, UP_BUFFER };
const char *UPLINK_NAME[] = { "none", "mqtt", "lora", "buffer" };

const int STUCK_WINDOW = 12, RING_CAPACITY = 48;
float histT[STUCK_WINDOW], histP[STUCK_WINDOW], histH[STUCK_WINDOW];
int histCount = 0, histPos = 0;

bool frozen = false, dropped = false;
bool wifiCut = false, loraUp = true, usingTls = true, clockSet = false;
float frozenH = NAN;
uint32_t seq = 0, lastSample = 0, scriptT0 = 0;
int phase = 0;

struct Sample { uint32_t ts; float t, p, h; uint32_t seq; char check[16]; };

// ---- protocol trace -------------------------------------------------------

void trace(const char *proto, const char *event, const char *fmt = nullptr, ...) {
  char detail[180] = "";
  if (fmt) {
    va_list ap; va_start(ap, fmt);
    vsnprintf(detail, sizeof detail, fmt, ap);
    va_end(ap);
  }
  Serial.printf("[%7.2f] %-5s %-14s %s\n", millis() / 1000.0, proto, event, detail);
}

void banner(const char *title) {
  Serial.println();
  Serial.printf("======== %s ========\n", title);
}

// ---- sensing and the on-device checks -------------------------------------

float jitter(float a) {
#if SIMULATE_SENSOR_NOISE
  return a * (random(-1000, 1001) / 1000.0);
#else
  return 0;
#endif
}

float seaLevel(float hpa) { return hpa * pow(1.0 - 0.0065 * STATION_ELEV_M / 288.15, -5.257); }

float dewpoint(float t, float rh) {
  float g = log(max(rh, 0.1f) / 100.0) + (17.625 * t) / (243.04 + t);
  return 243.04 * g / (17.625 - g);
}

float stdev(const float *v, int n) {
  float m = 0;
  for (int i = 0; i < n; i++) m += v[i];
  m /= n;
  float acc = 0;
  for (int i = 0; i < n; i++) acc += (v[i] - m) * (v[i] - m);
  return sqrt(acc / n);
}

/* Q1 of the slide: the range and sanity checks that gate the upload. */
const char *edgeCheck(float t, float p, float h) {
  if (isnan(t) || isnan(p) || isnan(h)) return "sensor_read";
  if (t < -60 || t > 55) return "temp_range";
  if (h < 0 || h > 100.5) return "rh_range";
  float slp = seaLevel(p);
  if (slp < 870 || slp > 1085) return "pressure_range";
  if (dewpoint(t, h) > t + 0.5) return "dewpoint_over_temp";

  histT[histPos] = t; histP[histPos] = p; histH[histPos] = h;
  histPos = (histPos + 1) % STUCK_WINDOW;
  if (histCount < STUCK_WINDOW) histCount++;
  if (histCount == STUCK_WINDOW) {
    if (stdev(histT, STUCK_WINDOW) < 0.05) return "stuck_temp";
    if (stdev(histP, STUCK_WINDOW) < 0.02) return "stuck_pressure";
    if (stdev(histH, STUCK_WINDOW) < 0.05) return "stuck_humidity";
  }
  return nullptr;
}

// ---- store and forward ----------------------------------------------------

void ringPush(const Sample &s) {
  nvs.begin("skyguard", false);
  int head = nvs.getInt("head", 0), count = nvs.getInt("count", 0);
  char key[8]; snprintf(key, sizeof key, "s%d", head);
  nvs.putBytes(key, &s, sizeof s);
  nvs.putInt("head", (head + 1) % RING_CAPACITY);
  nvs.putInt("count", min(count + 1, RING_CAPACITY));
  nvs.end();
  trace("NVS", "buffered", "seq=%lu depth=%d/%d (survives a reboot)",
        (unsigned long)s.seq, min(count + 1, RING_CAPACITY), RING_CAPACITY);
}

int ringDepth() {
  nvs.begin("skyguard", true);
  int c = nvs.getInt("count", 0);
  nvs.end();
  return c;
}

int ringRead(Sample *out, int maxOut) {
  nvs.begin("skyguard", true);
  int head = nvs.getInt("head", 0), count = min(nvs.getInt("count", 0), maxOut);
  for (int i = 0; i < count; i++) {
    int idx = (head - count + i + RING_CAPACITY) % RING_CAPACITY;
    char key[8]; snprintf(key, sizeof key, "s%d", idx);
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

size_t buildJson(char *buf, size_t len, const Sample &s, Uplink via) {
  char t[24], p[24], h[24], when[32];
  if (isnan(s.t)) strcpy(t, "null"); else snprintf(t, sizeof t, "%.2f", s.t);
  if (isnan(s.p)) strcpy(p, "null"); else snprintf(p, sizeof p, "%.2f", s.p);
  if (isnan(s.h)) strcpy(h, "null"); else snprintf(h, sizeof h, "%.1f", s.h);

  if (s.ts) {
    time_t secs = s.ts; struct tm tm; gmtime_r(&secs, &tm);
    strftime(when, sizeof when, "\"%Y-%m-%dT%H:%M:%SZ\"", &tm);
  } else {
    strcpy(when, "null");
  }

  return snprintf(buf, len,
      "{\"device\":\"%s\",\"ts\":%s,\"temp_c\":%s,\"pres_hpa\":%s,\"rh_pct\":%s,"
      "\"lat\":%.4f,\"lon\":%.4f,\"seq\":%lu,\"edge\":{\"ok\":%s,\"check\":%s%s%s},"
      "\"link\":{\"via\":\"%s\"},\"fw\":%lu}",
      DEVICE_ID, when, t, p, h, STATION_LAT, STATION_LON, (unsigned long)s.seq,
      s.check[0] ? "false" : "true",
      s.check[0] ? "\"" : "", s.check[0] ? s.check : "null", s.check[0] ? "\"" : "",
      UPLINK_NAME[via], (unsigned long)FW_VERSION);
}

// ---- rung 1: Wi-Fi, SNTP, TLS, MQTT ---------------------------------------

bool wifiUp() { return !wifiCut && WiFi.status() == WL_CONNECTED; }

void wifiConnect() {
  if (wifiCut || WiFi.status() == WL_CONNECTED) return;
  trace("PHY", "assoc", "ssid=%s ch=6", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS, 6);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000) delay(200);
  if (WiFi.status() == WL_CONNECTED)
    trace("DHCP", "lease", "ip=%s gw=%s rssi=%d dBm",
          WiFi.localIP().toString().c_str(), WiFi.gatewayIP().toString().c_str(), WiFi.RSSI());
  else
    trace("PHY", "assoc failed", "");
}

void syncClock() {
  if (clockSet || !wifiUp()) return;
  // Three servers, because the first one is often the slow one, and a short
  // timeout so a miss costs a second rather than stalling the whole boot.
  configTime(0, 0, NTP_POOL, "time.google.com", "time.cloudflare.com");
  struct tm tm;
  if (getLocalTime(&tm, 2500)) {
    clockSet = true;
    char iso[32]; strftime(iso, sizeof iso, "%Y-%m-%dT%H:%M:%SZ", &tm);
    trace("NTP", "sync", "utc=%s (the node stamps its own samples)", iso);
  }
}

/*
 * TLS on 8883 first. If the handshake will not complete, drop to plain 1883
 * and say so, rather than letting the demo die on stage.
 */
bool mqttConnect() {
  if (mqtt.connected()) return true;
  if (!wifiUp()) return false;

  static int tlsAttempts = 0;
  if (usingTls && tlsAttempts >= 2) {
    usingTls = false;
    trace("TLS", "giving up", "falling back to plain MQTT on %u", MQTT_PORT_PLAIN);
  }

  if (usingTls) {
    tlsAttempts++;
    tlsNet.setInsecure();  // paste the broker's root CA here to verify it
    trace("TLS", "handshake", "%s:%u (unverified: no CA pinned)", MQTT_HOST, MQTT_PORT_TLS);
    mqtt.begin(MQTT_HOST, MQTT_PORT_TLS, tlsNet);
  } else {
    mqtt.begin(MQTT_HOST, MQTT_PORT_PLAIN, plainNet);
  }
  mqtt.setKeepAlive(60);

  // The will is what turns a dead node into an event instead of a silence.
  mqtt.setWill(TOPIC_STATUS, "{\"state\":\"offline\"}", true, 1);

  char clientId[64];
  snprintf(clientId, sizeof clientId, "%s-%04x", DEVICE_ID, (unsigned)random(0xffff));
  trace("MQTT", "CONNECT", "clientId=%s keepalive=60s will=%s", clientId, TOPIC_STATUS);

  if (!mqtt.connect(clientId)) {
    trace("MQTT", "CONNACK fail", "rc=%d", mqtt.lastError());
    return false;
  }
  trace("MQTT", "CONNACK", "connected over %s", usingTls ? "TLS" : "TCP");
  mqtt.publish(TOPIC_STATUS, "{\"state\":\"online\"}", true, 1);  // retained
  return true;
}

bool publishMqtt(const char *json) {
  if (!mqttConnect()) return false;
  uint32_t t0 = millis();
  if (!mqtt.publish(TOPIC_READING, json, false, 1)) {
    trace("MQTT", "PUBLISH fail", "rc=%d", mqtt.lastError());
    return false;
  }
  trace("MQTT", "PUBACK", "qos=1 %ums %ub -> %s", (unsigned)(millis() - t0),
        (unsigned)strlen(json), TOPIC_READING);
  return true;
}

// ---- rung 2: LoRa (modelled) ----------------------------------------------

/*
 * Semtech's airtime formula, so the number on screen is the real cost of the
 * frame even though Wokwi has no radio to send it on. At SF9/BW125 a full
 * reading is about a quarter of a second of airtime, which is what caps a
 * node at roughly 140 transmissions an hour inside the band's 1 % duty cycle.
 */
float loraAirtimeMs(int payloadLen) {
  float tSym = (float)(1L << LORA_SF) / LORA_BW_HZ * 1000.0;
  float tPreamble = (8 + 4.25) * tSym;
  int num = 8 * payloadLen - 4 * LORA_SF + 28 + 16;
  int den = 4 * LORA_SF;
  int nPayload = 8 + max(0, (int)ceil((float)num / den) * (LORA_CR + 4));
  return tPreamble + nPayload * tSym;
}

bool sendLora(const char *json) {
  if (!loraUp) {
    trace("LORA", "ACK timeout", "(modelled) no gateway in range");
    return false;
  }
  int len = strlen(json) + strlen(DEVICE_ID) + 5;  // "SG1|<device>|<json>"
  float air = loraAirtimeMs(len);
  delay((uint32_t)air);  // the radio really would block for this long
  trace("LORA", "TX done", "(modelled) %.4f MHz sf=%d bw=125k %db airtime=%.0fms",
        LORA_MHZ, LORA_SF, len, air);
  trace("LORA", "ACK rx", "(modelled) gateway skyguard-gw-01 rssi=-97 dBm snr=7.5 dB");
  return true;
}

// ---- rung 3: drain the buffer over HTTPS -----------------------------------

void drainOverHttps() {
  int depth = ringDepth();
  if (depth == 0 || !wifiUp()) return;

  Sample *batch = (Sample *)malloc(sizeof(Sample) * depth);
  if (!batch) return;
  int n = ringRead(batch, depth);

  String body = "{\"device\":\"" DEVICE_ID "\",\"samples\":[";
  char one[400];
  for (int i = 0; i < n; i++) {
    buildJson(one, sizeof one, batch[i], UP_BUFFER);
    if (i) body += ",";
    body += one;
  }
  body += "]}";
  free(batch);

  banner("RUNG 3 - draining the backlog over HTTPS");
  httpNet.setInsecure();
  HTTPClient http;
  trace("HTTP", "POST", "%s %d samples %ub in one request", HTTP_BATCH_URL, n,
        (unsigned)body.length());
  http.begin(httpNet, HTTP_BATCH_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Id", DEVICE_ID);
  int code = http.POST(body);

  // Only a 2xx clears the buffer; anything else and they go again next cycle.
  if (code >= 200 && code < 300) {
    ringClear();
    trace("HTTP", "drained", "%d, %d samples accepted, nothing lost", code, n);
  } else {
    trace("HTTP", "POST failed", "%d, keeping %d samples buffered", code, n);
  }
  http.end();
}

void checkOta() {
  if (!wifiUp()) return;
  httpNet.setInsecure();
  HTTPClient http;
  http.begin(httpNet, OTA_MANIFEST_URL);
  int code = http.GET();
  if (code != 200) {
    trace("OTA", "manifest", "%d, staying on fw=%lu", code, (unsigned long)FW_VERSION);
    http.end();
    return;
  }
  String m = http.getString();
  http.end();
  int at = m.indexOf("\"version\":");
  uint32_t latest = at < 0 ? FW_VERSION : (uint32_t)m.substring(at + 10).toInt();
  if (latest > FW_VERSION)
    trace("OTA", "update ready", "fw=%lu -> %lu", (unsigned long)FW_VERSION, (unsigned long)latest);
  else
    trace("OTA", "up to date", "fw=%lu is the promoted build", (unsigned long)FW_VERSION);
}

// ---- the script -----------------------------------------------------------

void cutWifi(const char *why) {
  wifiCut = true;
  mqtt.disconnect();
  WiFi.disconnect(true);
  trace("LINK", "wifi lost", "%s", why);
}

void runScript() {
#if DEMO_SCRIPT
  if (!scriptT0) return;  // nothing has been delivered yet; the clock is not running
  uint32_t t = millis() - scriptT0;
  if (phase == 0 && t > T_WIFI_DOWN) {
    phase = 1;
    banner("RUNG 2 - Wi-Fi is gone, fall through to LoRa");
    cutWifi("the site's uplink dropped");
  } else if (phase == 1 && t > T_LORA_DOWN) {
    phase = 2;
    loraUp = false;
    banner("RUNG 3 - the gateway is out of range too, start buffering");
    trace("LINK", "gateway lost", "nothing left but flash");
  } else if (phase == 2 && t > T_WIFI_BACK) {
    phase = 3;
    wifiCut = false;
    loraUp = true;
    banner("RECOVERY - Wi-Fi is back");
    wifiConnect();
    mqttConnect();
  }
#endif
}

bool pressed(int pin, uint32_t &lastAt) {
  if (digitalRead(pin) == LOW && millis() - lastAt > 300) { lastAt = millis(); return true; }
  return false;
}

void readButtons() {
  static uint32_t fAt = 0, dAt = 0;
  if (pressed(PIN_BTN_FREEZE, fAt)) {
    frozen = !frozen;
    trace("FAULT", frozen ? "freeze on" : "freeze off", "humidity element latched");
  }
  if (pressed(PIN_BTN_DROP, dAt)) {
    dropped = !dropped;
    trace("FAULT", dropped ? "drop on" : "drop off", "sensor bus dead");
  }
}

// ---- main -----------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  delay(400);
  Serial.println();
  banner("SkyGuard station node - SIH 2026 demo");
  trace("BOOT", "start", "device=%s fw=%lu", DEVICE_ID, (unsigned long)FW_VERSION);
  trace("BOOT", "note", "LoRa is modelled: Wokwi has no SX1278 part");

  pinMode(PIN_BTN_FREEZE, INPUT_PULLUP);
  pinMode(PIN_BTN_DROP, INPUT_PULLUP);
  pinMode(PIN_LED_ALERT, OUTPUT);
  pinMode(PIN_LED_TX, OUTPUT);
  pinMode(PIN_LED_LINK, OUTPUT);
  analogReadResolution(12);
  dht.setup(PIN_DHT, DHTesp::DHT22);
  randomSeed(esp_random());

  int backlog = ringDepth();
  if (backlog) trace("NVS", "backlog", "%d samples held from the last run", backlog);

  banner("RUNG 1 - the normal path");
  wifiConnect();
  syncClock();
  mqttConnect();
  checkOta();
}

void loop() {
  readButtons();
  runScript();

  // Keep trying until the clock lands; until then samples honestly say null.
  static uint32_t lastNtpTry = 0;
  if (!clockSet && wifiUp() && millis() - lastNtpTry > 5000) {
    lastNtpTry = millis();
    syncClock();
  }
  if (mqtt.connected()) mqtt.loop();
  digitalWrite(PIN_LED_LINK, wifiUp() && mqtt.connected());

  if (millis() - lastSample < SAMPLE_MS) return;
  lastSample = millis();

  Sample s;
  s.seq = ++seq;
  s.ts = clockSet ? (uint32_t)time(nullptr) : 0;
  s.check[0] = 0;

  if (dropped) {
    s.t = s.p = s.h = NAN;
  } else {
    TempAndHumidity th = dht.getTempAndHumidity();
    s.t = th.temperature + jitter(0.15);
    s.h = th.humidity + jitter(0.40);
    s.p = 860.0 + analogRead(PIN_PRESSURE) * (100.0 / 4095.0) + jitter(0.10);
  }

  // One element latches while the others carry on: the hard fault to spot.
  if (frozen && !isnan(s.h)) {
    if (isnan(frozenH)) frozenH = s.h;
    s.h = frozenH;
  } else if (!frozen) {
    frozenH = NAN;
  }

  const char *failed = edgeCheck(s.t, s.p, s.h);
  if (failed) strncpy(s.check, failed, sizeof s.check - 1);
  digitalWrite(PIN_LED_ALERT, failed ? HIGH : LOW);
  trace("EDGE", failed ? "check FAILED" : "checks pass", "t=%.2fC p=%.1fhPa rh=%.1f%%%s%s",
        s.t, s.p, s.h, failed ? " -> " : "", failed ? failed : "");

  // The ladder.
  char json[400];
  Uplink via = UP_NONE;
  buildJson(json, sizeof json, s, UP_MQTT);
  if (publishMqtt(json)) {
    via = UP_MQTT;
    if (!scriptT0) {
      scriptT0 = millis();
      trace("DEMO", "script armed", "wifi drops in %lus", (unsigned long)(T_WIFI_DOWN / 1000));
    }
  } else {
    buildJson(json, sizeof json, s, UP_LORA);
    if (sendLora(json)) via = UP_LORA;
    else { ringPush(s); via = UP_BUFFER; }
  }

  digitalWrite(PIN_LED_TX, HIGH);
  delay(40);
  digitalWrite(PIN_LED_TX, LOW);
  trace("LINK", "sample done", "seq=%lu via=%s", (unsigned long)s.seq, UPLINK_NAME[via]);

  if (via == UP_MQTT) drainOverHttps();
}
