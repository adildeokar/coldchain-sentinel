/* Static configuration: product profiles, defaults (mirror firmware/config.yaml),
 * GPIO map, network and cloud timing models, bill of materials. */
(function (CS) {
  'use strict';

  const PROFILES = {
    pharma:  { label: 'Pharma / vaccines', tMin: 2, tMax: 8, hMin: 35, hMax: 75, setpoint: 5, baseRh: 55 },
    produce: { label: 'Fresh produce', tMin: 0, tMax: 5, hMin: 80, hMax: 95, setpoint: 2.5, baseRh: 88 },
    frozen:  { label: 'Frozen food', tMin: -25, tMax: -15, hMin: 40, hMax: 95, setpoint: -20, baseRh: 70 },
  };

  // Mirrors firmware/config.yaml. Twin desired properties override the threshold block.
  const DEFAULTS = {
    deviceId: 'coldstore-pi-01',
    baselineId: 'baseline-node-02',
    firmware: '1.4.2',
    site: 'Warehouse A / Cold Room 1',
    profile: 'pharma',
    sampleIntervalS: 5,
    dht22Retries: 3,
    alarmDelaySamples: 2,
    tempHystC: 0.3,
    rhHystPct: 2,
    warnMarginC: 0.5,
    doorOpenMaxS: 120,
    sensorDisagreeC: 1.5,
    bufferCapacity: 100000,
    batchSize: 50,
    syncIntervalS: 0.5,
    pubackTimeoutS: 4,
    backoffInitialS: 1,
    backoffMaxS: 32,
    keepAliveS: 60,
    connectTimeoutS: 3,
  };

  const HUB = {
    name: 'coldchain-iothub',
    host: 'coldchain-iothub.azure-devices.net',
    region: 'Central India',
    sku: 'S1 Standard',
    dailyQuota: 400000,         // S1: 400k messages/unit/day
    meterBytes: 4096,           // S1 meters messages in 4 KB blocks
    keepAliveGrace: 1.5,        // hub drops an MQTT session after 1.5 × keep-alive of silence
  };

  // One-way latency (ms) and loss per packet for the site's WAN link
  const NET = {
    online:   { label: 'Online',   latency: 42,  jitter: 22,  loss: 0.001, kbps: 20000 },
    degraded: { label: 'Degraded', latency: 650, jitter: 450, loss: 0.12,  kbps: 256 },
    offline:  { label: 'Offline',  latency: 0,   jitter: 0,   loss: 1,     kbps: 0 },
  };

  // Cloud service processing times (ms) — [min, max]
  const CLOUD = {
    hubIngest: [6, 22],
    serviceBus: [12, 40],
    fnWarm: [35, 140],
    fnCold: [900, 2200],        // Consumption plan cold start after ~20 min idle
    fnIdleColdMs: 20 * 60 * 1000,
    cosmosWrite: [6, 18],
    logicApp: [350, 900],       // Logic App → Communication Services SMS/e-mail
    signalR: [20, 65],
    asa: [1200, 3200],          // Stream Analytics end-to-end processing delay
    eventGrid: [800, 2500],     // device connection-state events
    twinOp: [15, 45],
  };

  // Wire overhead model (bytes) used for bandwidth + security-overhead numbers
  const WIRE = {
    tcpIp: 40,                  // IPv4 20 + TCP 20
    tlsRecord: 29,              // TLS 1.2 AES-GCM: 5 header + 8 explicit nonce + 16 tag
    mqttFixed: 4,               // fixed header + packet id
    puback: 4,
    tlsHandshakeUp: 620,        // ClientHello, key exchange, Finished
    tlsHandshakeDown: 5400,     // ServerHello + Azure certificate chain
    mqttConnect: 420,           // CONNECT with SAS token as password
    subscribe: 160,             // twin + direct-method topics
    twinGet: 640,
  };

  // BCM → physical pin and what is connected
  const GPIO = [
    { bcm: 4,  pin: 7,  name: 'GPIO4',  dir: 'IN',  use: 'DS18B20 1-Wire data', comp: 'ds18b20' },
    { bcm: 17, pin: 11, name: 'GPIO17', dir: 'IN',  use: 'DHT22 data', comp: 'dht22' },
    { bcm: 27, pin: 13, name: 'GPIO27', dir: 'IN',  use: 'Door reed switch (HIGH = open)', comp: 'reed' },
    { bcm: 22, pin: 15, name: 'GPIO22', dir: 'IN',  use: 'Acknowledge button (LOW = pressed)', comp: 'button' },
    { bcm: 18, pin: 12, name: 'GPIO18', dir: 'OUT', use: 'Buzzer driver (2N2222 base)', comp: 'buzzer' },
    { bcm: 23, pin: 16, name: 'GPIO23', dir: 'OUT', use: 'Red LED — ALARM', comp: 'ledRed' },
    { bcm: 24, pin: 18, name: 'GPIO24', dir: 'OUT', use: 'Green LED — all OK', comp: 'ledGreen' },
    { bcm: 25, pin: 22, name: 'GPIO25', dir: 'OUT', use: 'Amber LED — cloud offline / syncing', comp: 'ledAmber' },
    { bcm: 2,  pin: 3,  name: 'GPIO2 SDA', dir: 'I2C', use: 'LCD PCF8574 SDA (0x27)', comp: 'lcd' },
    { bcm: 3,  pin: 5,  name: 'GPIO3 SCL', dir: 'I2C', use: 'LCD PCF8574 SCL', comp: 'lcd' },
  ];

  const COMPONENTS = {
    rpi:      { name: 'Raspberry Pi 4 Model B (4 GB)', role: 'Edge gateway: sampling, local rules, alarm, SQLite buffer, MQTT/TLS to IoT Hub', spec: 'BCM2711 4×Cortex-A72 1.5 GHz · 4 GB LPDDR4 · Wi-Fi 802.11ac · Gigabit Ethernet · 40-pin GPIO · 5 V 3 A USB-C', file: 'firmware/main.py', anchor: 'def main' },
    ds18b20:  { name: 'DS18B20 waterproof probe', role: 'Primary temperature sensor (1-Wire)', spec: '−55…+125 °C · ±0.5 °C (−10…85 °C) · 12-bit (0.0625 °C) · 750 ms conversion · 4.7 kΩ pull-up', file: 'firmware/coldstore/sensors/ds18b20.py', anchor: 'def parse_w1_slave' },
    dht22:    { name: 'DHT22 / AM2302', role: 'Relative humidity + secondary temperature', spec: '0…100 %RH ±2 % · −40…80 °C ±0.5 °C · 0.5 Hz max · single-wire · 10 kΩ pull-up', file: 'firmware/coldstore/sensors/dht22.py', anchor: 'def read' },
    reed:     { name: 'MC-38 magnetic reed switch', role: 'Door open/closed detection', spec: 'NO contact, 15–25 mm gap · internal pull-up on GPIO27 · 50 ms debounce', file: 'firmware/coldstore/sensors/door.py', anchor: 'class DoorSensor' },
    buzzer:   { name: '5 V active buzzer + 2N2222', role: 'Audible local alarm (works offline)', spec: '85 dB @ 10 cm · ~30 mA → driven by NPN transistor, 1 kΩ base resistor', file: 'firmware/coldstore/actuators/alarm.py', anchor: 'def raise_alarm' },
    ledRed:   { name: 'Red LED (5 mm)', role: 'ALARM indicator — blinks for critical', spec: '330 Ω series resistor → ~4 mA', file: 'firmware/coldstore/actuators/alarm.py', anchor: 'def raise_alarm' },
    ledGreen: { name: 'Green LED (5 mm)', role: 'System OK', spec: '330 Ω series resistor', file: 'firmware/coldstore/actuators/alarm.py', anchor: 'def clear_alarm' },
    ledAmber: { name: 'Amber LED (5 mm)', role: 'Cloud offline (solid) / syncing backlog (fast blink)', spec: '330 Ω series resistor', file: 'firmware/coldstore/actuators/alarm.py', anchor: 'def set_cloud_online' },
    button:   { name: 'Tactile push button', role: 'Acknowledge — silences the buzzer locally', spec: 'GPIO22 to GND, internal pull-up, 100 ms debounce', file: 'firmware/coldstore/actuators/alarm.py', anchor: 'def acknowledge' },
    lcd:      { name: '16×2 LCD + PCF8574 I²C backpack', role: 'Local readout at the cold-room door', spec: 'HD44780 · I²C 0x27 · SDA GPIO2 / SCL GPIO3 · 5 V (level-shift SDA/SCL)', file: 'firmware/coldstore/actuators/lcd.py', anchor: 'def render' },
    sqlite:   { name: 'SQLite queue (queue.db on microSD)', role: 'Store-and-forward buffer — survives outages and reboots', spec: 'WAL journal · synchronous=FULL · capacity 100 000 rows (~5.8 days @ 5 s)', file: 'firmware/coldstore/store.py', anchor: 'class Store' },
    ups:      { name: 'UPS HAT (2× 18650)', role: 'Keeps the Pi + alarm alive through a site power cut', spec: '~4–6 h runtime at 3 W · I²C fuel gauge', file: 'firmware/coldstore.service', anchor: 'Restart=always' },
    router:   { name: '4G / Wi-Fi router', role: 'Site WAN uplink (the link we cut in the outage tests)', spec: 'Dual WAN recommended (fibre + 4G failover)', file: 'firmware/coldstore/uploader.py', anchor: 'class Uploader' },
  };

  const BOM = [
    ['Raspberry Pi 4 Model B 4 GB', 1, 5500],
    ['DS18B20 waterproof probe (1 m)', 1, 150],
    ['DHT22 / AM2302 module', 1, 350],
    ['MC-38 magnetic door reed switch', 1, 80],
    ['5 V active buzzer', 1, 30],
    ['LEDs red / green / amber + 3×330 Ω', 1, 25],
    ['2N2222 NPN transistor + 1 kΩ', 1, 10],
    ['Resistors 4.7 kΩ, 10 kΩ pull-ups', 1, 10],
    ['Tactile push button', 1, 10],
    ['16×2 LCD with PCF8574 I²C backpack', 1, 250],
    ['UPS HAT with 2× 18650 cells', 1, 1800],
    ['32 GB microSD (A1, endurance)', 1, 450],
    ['5 V 3 A USB-C power supply', 1, 600],
    ['IP54 enclosure, cable glands, jumper wires', 1, 450],
  ];

  CS.config = { PROFILES, DEFAULTS, HUB, NET, CLOUD, WIRE, GPIO, COMPONENTS, BOM };
})(typeof window !== 'undefined' ? (window.CS = window.CS || {}) : (global.CS = global.CS || {}));
