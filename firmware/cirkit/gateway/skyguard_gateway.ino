/*
 * SkyGuard LoRa gateway — the second ESP32 in the Cirkit Designer project.
 *
 * A weather station worth instrumenting is usually somewhere without Wi-Fi.
 * This board sits where there is a link, listens on the 865 MHz ISM band for
 * frames from any SkyGuard node in range, acknowledges each one so the node
 * knows it can stop holding the sample, and republishes it on the node's own
 * MQTT topic. To everything upstream a relayed reading is indistinguishable
 * from one the node published itself, except for the "via":"lora" field and
 * the radio quality the gateway attaches.
 *
 * One gateway serves as many nodes as the band can carry. Nothing here is
 * per-node: the device id travels in the frame.
 *
 *   node --LoRa SF9--> [gateway] --Wi-Fi/TLS--> MQTT QoS 1 --> AWS IoT Core
 */

#include <stdarg.h>
#include <SPI.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <LoRa.h>
#include <MQTT.h>

// ---- configuration --------------------------------------------------------

#define GATEWAY_ID "skyguard-gw-01"

const char *WIFI_SSID = "Wokwi-GUEST";
const char *WIFI_PASS = "";
const char *MQTT_HOST = "broker.hivemq.com";
const uint16_t MQTT_PORT = 8883;

// Must match the node exactly, or the two radios never hear each other.
const long LORA_FREQ_HZ = 865062500;
const int LORA_SF = 9;
const long LORA_BW_HZ = 125000;
const int LORA_TX_DBM = 17;
const uint8_t LORA_SYNC_WORD = 0x53;

const int PIN_LORA_SCK = 18;
const int PIN_LORA_MISO = 19;
const int PIN_LORA_MOSI = 23;
const int PIN_LORA_CS = 5;
const int PIN_LORA_RST = 14;
const int PIN_LORA_DIO0 = 26;

const int PIN_LED_RX = 25;    // green, blinks on a frame received
const int PIN_LED_LINK = 13;  // blue, lit while MQTT is up

// ---------------------------------------------------------------------------

WiFiClientSecure tls;
MQTTClient mqtt(768);
uint32_t relayed = 0, dropped = 0;

void trace(const char *proto, const char *event, const char *fmt = nullptr, ...) {
  char detail[200] = "";
  if (fmt) {
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(detail, sizeof detail, fmt, ap);
    va_end(ap);
  }
  Serial.printf("[%8.3f] %-5s %-13s %s\n", millis() / 1000.0, proto, event, detail);
}

void wifiConnect() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS, 6);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 12000) delay(200);
  if (WiFi.status() == WL_CONNECTED)
    trace("DHCP", "lease", "ip=%s rssi=%d dBm", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  else
    trace("PHY", "assoc failed", "frames will be acked but not relayed");
}

bool mqttConnect() {
  if (mqtt.connected()) return true;
  if (WiFi.status() != WL_CONNECTED) return false;

  tls.setInsecure();  // paste the account's root CA here for a real endpoint
  mqtt.begin(MQTT_HOST, MQTT_PORT, tls);
  mqtt.setKeepAlive(60);

  // If the gateway dies, every node behind it goes quiet at once. Saying so
  // on a retained topic is what stops that looking like fifteen dead sensors.
  mqtt.setWill("skyguard/" GATEWAY_ID "/status", "{\"state\":\"offline\"}", true, 1);

  char clientId[64];
  snprintf(clientId, sizeof clientId, "%s-%04x", GATEWAY_ID, (unsigned)random(0xffff));
  if (!mqtt.connect(clientId)) {
    trace("MQTT", "CONNACK fail", "rc=%d", mqtt.lastError());
    return false;
  }
  trace("MQTT", "CONNACK", "clientId=%s", clientId);
  mqtt.publish("skyguard/" GATEWAY_ID "/status", "{\"state\":\"online\"}", true, 1);
  return true;
}

/*
 * Frames are "SG1|<device>|<json>". Anything that does not parse is counted
 * and thrown away: the band is shared, and a gateway that relays whatever it
 * hears is an open door onto the topic namespace.
 */
void onFrame(int packetSize) {
  if (!packetSize) return;
  String frame = LoRa.readString();
  int rssi = LoRa.packetRssi();
  float snr = LoRa.packetSnr();

  digitalWrite(PIN_LED_RX, HIGH);
  trace("LORA", "RX", "%d bytes rssi=%d dBm snr=%.1f dB", packetSize, rssi, snr);

  if (!frame.startsWith("SG1|")) {
    dropped++;
    trace("LORA", "dropped", "not a SkyGuard frame");
    digitalWrite(PIN_LED_RX, LOW);
    return;
  }
  int bar = frame.indexOf('|', 4);
  if (bar < 0) {
    dropped++;
    trace("LORA", "dropped", "malformed header");
    digitalWrite(PIN_LED_RX, LOW);
    return;
  }
  String device = frame.substring(4, bar);
  String json = frame.substring(bar + 1);

  // Ack first. The node is holding the sample in RAM waiting for this, and a
  // node that gives up writes to flash it did not need to write.
  LoRa.beginPacket();
  LoRa.print("ACK|");
  LoRa.print(device);
  LoRa.print("|rssi=");
  LoRa.print(rssi);
  LoRa.endPacket();
  LoRa.receive();
  trace("LORA", "ACK tx", "to %s", device.c_str());

  // Tag the hop, so a reading that came the long way is still traceable.
  int close = json.lastIndexOf('}');
  if (close > 0) {
    json = json.substring(0, close) + ",\"gw\":{\"id\":\"" GATEWAY_ID "\",\"rssi\":" +
           String(rssi) + ",\"snr\":" + String(snr, 1) + "}}";
  }

  String topic = "skyguard/" + device + "/reading";
  if (mqttConnect() && mqtt.publish(topic, json, false, 1)) {
    relayed++;
    trace("MQTT", "PUBACK", "relayed #%lu qos=1 -> %s", (unsigned long)relayed, topic.c_str());
  } else {
    dropped++;
    trace("MQTT", "relay failed", "sample lost; the node already has its ACK");
  }
  digitalWrite(PIN_LED_RX, LOW);
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  trace("BOOT", "start", "SkyGuard gateway %s", GATEWAY_ID);

  pinMode(PIN_LED_RX, OUTPUT);
  pinMode(PIN_LED_LINK, OUTPUT);
  randomSeed(esp_random());

  SPI.begin(PIN_LORA_SCK, PIN_LORA_MISO, PIN_LORA_MOSI, PIN_LORA_CS);
  LoRa.setPins(PIN_LORA_CS, PIN_LORA_RST, PIN_LORA_DIO0);
  if (!LoRa.begin(LORA_FREQ_HZ)) {
    trace("LORA", "radio missing", "check SPI wiring; halting");
    while (true) delay(1000);
  }
  LoRa.setSpreadingFactor(LORA_SF);
  LoRa.setSignalBandwidth(LORA_BW_HZ);
  LoRa.setTxPower(LORA_TX_DBM);
  LoRa.setSyncWord(LORA_SYNC_WORD);
  LoRa.enableCrc();
  LoRa.receive();
  trace("LORA", "listening", "%.4f MHz sf=%d bw=%ldk sync=0x%02X", LORA_FREQ_HZ / 1e6,
        LORA_SF, LORA_BW_HZ / 1000, LORA_SYNC_WORD);

  wifiConnect();
  mqttConnect();
}

void loop() {
  wifiConnect();
  if (mqtt.connected()) mqtt.loop();
  digitalWrite(PIN_LED_LINK, mqtt.connected());

  onFrame(LoRa.parsePacket());

  static uint32_t lastReport = 0;
  if (millis() - lastReport > 60000) {
    lastReport = millis();
    trace("GW", "counters", "relayed=%lu dropped=%lu uptime=%lus",
          (unsigned long)relayed, (unsigned long)dropped, millis() / 1000);
  }
}
