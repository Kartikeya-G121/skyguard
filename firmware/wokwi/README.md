# The browser build

This folder runs on **wokwi.com only**. There is no `wokwi.toml` or
`platformio.ini` here, so the Wokwi VS Code extension cannot open it — if you
opened this folder in VS Code and nothing happened, that is why.

- **Recording the demo, or working in VS Code?** Use
  [`../wokwi-demo/`](../wokwi-demo/README.md) instead.
- **Just want something on screen in two minutes?** Paste `sketch.ino` and
  `diagram.json` into <https://wokwi.com/projects/new/esp32>.

The two builds are different on purpose:

| | `wokwi/` (here) | `wokwi-demo/` |
| --- | --- | --- |
| Runs in | Browser only | VS Code **and** browser |
| MQTT library | PubSubClient (QoS 0) | arduino-mqtt (QoS 1) |
| Transport | Plain MQTT, port 1883 | TLS, port 8883 |
| Shows | One reading path | The full uplink ladder |
