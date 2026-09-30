/*
 * SkyGuard ESP32 station node.
 *
 * Reads temperature and humidity from a DHT22 and pressure from an analog
 * input, runs the cheap checks that fit on the device, and publishes one JSON
 * sample every 2 s to skyguard/<DEVICE_ID>/reading over MQTT. The dashboard
 * subscribes to the same topic and runs the full detector on it.
 *
 * Wokwi circuit (diagram.json):
 *   DHT22 data      -> GPIO 15
 *   Potentiometer   -> GPIO 34   stands in for a barometer, 860-960 hPa
 *   FREEZE button   -> GPIO 18   latches the humidity reading (a stuck sensor)
 *   DROP button     -> GPIO 19   stops publishing (a dead radio link)
 *   Red LED         -> GPIO 4    an on-device check failed
 *   Green LED       -> GPIO 16   blinks on each publish
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <math.h>
#include "DHTesp.h"

// ---- configuration --------------------------------------------------------

// Must match the Device ID entered on the dashboard's Fleet page. Pick
// something unique: the default broker is public and shared.
#define DEVICE_ID "skyguard-demo"

const char *WIFI_SSID = "Wokwi-GUEST";  // Wokwi's simulated access point
const char *WIFI_PASS = "";
const char *MQTT_HOST = "broker.hivemq.com";
const uint16_t MQTT_PORT = 1883;

const uint32_t PUBLISH_MS = 2000;
const float STATION_ELEV_M = 900.0;  // Bengaluru; used to check pressure

// Simulated sensors return perfectly steady values, and a perfectly steady
// value is exactly what the stuck-sensor check exists to catch. This adds the
// small jitter a real sensor has. Set to 0 on real hardware.
#define SIMULATE_SENSOR_NOISE 1

// ---- pins -----------------------------------------------------------------

const int PIN_DHT = 15;
const int PIN_PRESSURE = 34;
const int PIN_FREEZE = 18;
const int PIN_DROP = 19;
const int PIN_LED_ALERT = 4;
const int PIN_LED_TX = 16;

// ---------------------------------------------------------------------------

DHTesp dht;
WiFiClient net;
PubSubClient mqtt(net);

const char *topic = "skyguard/" DEVICE_ID "/reading";

bool frozen = false;
bool dropped = false;
float frozenH = NAN;
uint32_t seq = 0;
uint32_t lastPublish = 0;

// Rolling window for the on-device checks.
const int WINDOW = 12;
float histT[WINDOW], histP[WINDOW], histH[WINDOW];
int histCount = 0, histPos = 0;

float jitter(float amplitude) {
#if SIMULATE_SENSOR_NOISE
  return amplitude * (random(-1000, 1001) / 1000.0);
#else
  return 0;
#endif
}

void connectWiFi() {
  Serial.print("WiFi");
  WiFi.begin(WIFI_SSID, WIFI_PASS, 6);  // channel 6 skips the scan in Wokwi
  while (WiFi.status() != WL_CONNECTED) {
    delay(250);
    Serial.print(".");
  }
  Serial.println(" connected");
}

void connectMqtt() {
  while (!mqtt.connected()) {
    String clientId = String("skyguard-") + DEVICE_ID + "-" + String(random(0xffff), HEX);
    Serial.print("MQTT ");
    if (mqtt.connect(clientId.c_str())) {
      Serial.println("connected");
    } else {
      Serial.printf("failed (state %d), retrying\n", mqtt.state());
      delay(2000);
    }
  }
}

// Press toggles; a short lockout stands in for debouncing.
bool pressed(int pin, uint32_t &lastAt) {
  if (digitalRead(pin) == LOW && millis() - lastAt > 300) {
    lastAt = millis();
    return true;
  }
  return false;
}

float seaLevel(float p) {
  return p * pow(1.0 - 0.0065 * STATION_ELEV_M / 288.15, -5.257);
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
 * The checks from the dashboard's "on station" row: physical ranges and a
 * stuck-value test over the last 12 samples. Returns the failing check's
 * name, or nullptr when every check passes.
 */
const char *edgeCheck(float t, float p, float h) {
  if (isnan(t) || isnan(p) || isnan(h)) return "sensor_read";
  if (t < -60 || t > 55) return "temp_range";
  if (h < 0 || h > 100.5) return "rh_range";
  float slp = seaLevel(p);
  if (slp < 870 || slp > 1085) return "pressure_range";

  histT[histPos] = t;
  histP[histPos] = p;
  histH[histPos] = h;
  histPos = (histPos + 1) % WINDOW;
  if (histCount < WINDOW) histCount++;
  if (histCount == WINDOW) {
    if (stdev(histT, WINDOW) < 0.05) return "stuck_temp";
    if (stdev(histP, WINDOW) < 0.02) return "stuck_pressure";
    if (stdev(histH, WINDOW) < 0.05) return "stuck_humidity";
  }
  return nullptr;
}

// Writes a JSON number, or null for a failed read.
void appendValue(char *buf, size_t len, const char *key, float v, int dp) {
  size_t used = strlen(buf);
  if (isnan(v)) snprintf(buf + used, len - used, "\"%s\":null,", key);
  else snprintf(buf + used, len - used, "\"%s\":%.*f,", key, dp, v);
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_FREEZE, INPUT_PULLUP);
  pinMode(PIN_DROP, INPUT_PULLUP);
  pinMode(PIN_LED_ALERT, OUTPUT);
  pinMode(PIN_LED_TX, OUTPUT);
  analogReadResolution(12);
  dht.setup(PIN_DHT, DHTesp::DHT22);
  randomSeed(esp_random());

  connectWiFi();
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  connectMqtt();
  Serial.printf("Publishing to %s every %lu ms\n", topic, (unsigned long)PUBLISH_MS);
}

void loop() {
  static uint32_t freezeAt = 0, dropAt = 0;
  if (pressed(PIN_FREEZE, freezeAt)) {
    frozen = !frozen;
    Serial.println(frozen ? "FREEZE on: humidity latched" : "FREEZE off");
  }
  if (pressed(PIN_DROP, dropAt)) {
    dropped = !dropped;
    Serial.println(dropped ? "DROP on: not publishing" : "DROP off");
  }

  if (!mqtt.connected()) connectMqtt();
  mqtt.loop();

  if (millis() - lastPublish < PUBLISH_MS) return;
  lastPublish = millis();

  TempAndHumidity th = dht.getTempAndHumidity();
  float t = th.temperature + jitter(0.15);
  float h = th.humidity + jitter(0.4);
  float p = 860.0 + analogRead(PIN_PRESSURE) * (100.0 / 4095.0) + jitter(0.1);

  // A latched sensor is usually one sensor: the humidity element stops
  // updating while temperature and pressure carry on.
  if (frozen) {
    if (isnan(frozenH)) frozenH = h;
    h = frozenH;
  } else {
    frozenH = NAN;
  }

  const char *failed = edgeCheck(t, p, h);
  digitalWrite(PIN_LED_ALERT, failed ? HIGH : LOW);

  if (dropped) {
    digitalWrite(PIN_LED_TX, LOW);
    Serial.println("(not published: DROP)");
    return;
  }

  char body[200] = "{";
  appendValue(body, sizeof body, "temp_c", t, 2);
  appendValue(body, sizeof body, "pres_hpa", p, 2);
  appendValue(body, sizeof body, "rh_pct", h, 1);
  size_t used = strlen(body);
  if (failed) {
    snprintf(body + used, sizeof body - used,
             "\"seq\":%lu,\"edge\":{\"ok\":false,\"check\":\"%s\"}}", (unsigned long)++seq, failed);
  } else {
    snprintf(body + used, sizeof body - used,
             "\"seq\":%lu,\"edge\":{\"ok\":true,\"check\":null}}", (unsigned long)++seq);
  }

  bool ok = mqtt.publish(topic, body);
  digitalWrite(PIN_LED_TX, HIGH);
  delay(40);
  digitalWrite(PIN_LED_TX, LOW);
  Serial.printf("%s %s\n", ok ? "->" : "!!", body);
}
