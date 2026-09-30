# Wire formats

Everything the node puts on a wire or a radio, in the order the uplink ladder
tries it. The JSON body is identical on all three paths, so the cloud never has
to care how a reading arrived.

## The reading

One object per sample. The first six fields are the `Reading` contract from
[`web/src/lib/contract.js`](../../web/src/lib/contract.js); the rest is what a
real device knows and a simulated station does not. The dashboard ignores
fields it does not recognise, so this stays backward compatible.

```json
{
  "device": "skyguard-bmsce-01",
  "ts": "2026-09-30T08:14:22Z",
  "temp_c": 24.08, "pres_hpa": 909.02, "rh_pct": 40.2,
  "lat": 12.9416, "lon": 77.5656, "elev_m": 920,
  "seq": 17,
  "edge": { "ok": true, "check": null },
  "link": { "via": "mqtt", "rssi": -58 },
  "batt_v": 3.94, "fw": 4
}
```

A sensor that failed to read sends `null` for that field rather than a
placeholder number, because a placeholder is indistinguishable from a
measurement once it is in the database. `ts` is `null` until SNTP succeeds: the
node would rather admit it does not know the time than guess it.

`edge.check` names the failing check, one of `temp_range`, `rh_range`,
`pressure_range`, `dewpoint_over_temp`, `stuck_temp`, `stuck_pressure`,
`stuck_humidity`, `sensor_read`.

## 1 · MQTT over TLS

| | |
| --- | --- |
| Broker | AWS IoT Core, port 8883, mutual TLS |
| Client id | `<device>-<random16>` |
| Keepalive | 60 s, so a silent node is noticed within a minute |
| Readings | `skyguard/<device>/reading` — **QoS 1**, not retained |
| Status | `skyguard/<device>/status` — QoS 1, **retained** |
| Commands | `skyguard/<device>/cmd` — subscribed at QoS 1 |
| Will | `{"state":"offline"}` on the status topic, retained, QoS 1 |

**QoS 1** is the reason this project uses the `arduino-mqtt` library rather
than PubSubClient: PubSubClient publishes at QoS 0 only, so there is no PUBACK
and no way to know a reading landed. Here `publish()` blocks for the PUBACK,
and a failure drops the sample to the next rung instead of losing it.

**Retained status** means a dashboard that connects an hour later still learns
the node is up, without waiting for the next sample.

**The last will** is what turns a dropout into an event. If the node stops
answering PINGREQ, the broker publishes `offline` on its behalf. Without it a
dead station is just an absence of messages, which looks the same as a quiet
one.

Commands are a small set: `{"cmd":"recalibrate"}` clears the stuck-value
window after a site visit, `{"cmd":"ota"}` forces an update check.

On AWS IoT Core the topics above map straight to a rule; the certificate's
policy should be scoped to `skyguard/${iot:ClientId}/*` so one compromised node
cannot publish as another.

## 2 · LoRa to the gateway

Used when Wi-Fi is not available, which at a real AWS site is most of the time.

| | |
| --- | --- |
| Band | 865.0625 MHz — India's licence-free 865–867 MHz ISM band |
| Modulation | SF9, BW 125 kHz, CR 4/5, CRC on |
| Sync word | `0x53` (`'S'`), so unrelated traffic is not even decoded |
| Power | 17 dBm |
| Airtime | ~250 ms for a full frame |

Frame, as text, because a text frame is debuggable and fits the budget:

```
SG1|<device>|<the reading JSON above>
```

The gateway acknowledges every frame it accepts:

```
ACK|<device>|rssi=-97
```

The node waits 1.2 s for that ack. No ack means the frame was lost and the
sample goes to the buffer — this is the one place the node can tell the
difference between "sent" and "delivered" on the radio.

The gateway adds its own hop before republishing, so a relayed reading stays
traceable:

```json
"gw": { "id": "skyguard-gw-01", "rssi": -97, "snr": 7.5 }
```

Duty cycle matters: at SF9 a frame is about 250 ms of airtime, so the 1 %
limit on the band caps a node at roughly 140 transmissions an hour. The Fleet
page's default of six per hour is well inside that.

## 3 · Buffer, then HTTPS

When neither radio gets through, the sample goes into a 48-entry ring buffer in
NVS. NVS rather than RAM, so it survives a reboot and a deep sleep; a ring
rather than a log, so flash wear is bounded. At 48 samples the oldest is
overwritten — the node keeps the most recent history rather than the start of
the outage.

Once MQTT succeeds again, the whole backlog goes up in a single POST:

```http
POST /v1/ingest/batch HTTP/1.1
Content-Type: application/json
X-Device-Id: skyguard-bmsce-01

{ "device": "skyguard-bmsce-01", "samples": [ {...}, {...} ] }
```

One TLS handshake drains the entire backlog, however deep. The buffer is
cleared **only** on a 2xx; any other status and the samples stay put and go
again next cycle, which is the whole reason for storing them.

## Time

SNTP against `pool.ntp.org` at boot, UTC on the wire throughout. The node
stamps its own samples rather than letting the broker do it, so a sample
buffered through a six-hour outage keeps the time it was actually measured
instead of the time it was finally delivered.

## Firmware updates

The MLOps loop on the technical-approach slide promotes a new model version;
this is how the promoted build reaches the fleet. Every 5 minutes the node
fetches a manifest over HTTPS:

```json
{ "version": 5, "url": "https://.../skyguard-node-v5.bin", "sha256": "..." }
```

A higher version than the running one is streamed straight into the inactive
OTA partition — the image does not fit in RAM — verified, and the node
reboots into it. A failed write leaves the running partition untouched.
