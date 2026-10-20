#!/usr/bin/env bash
# One-time Raspberry Pi setup for ColdChain Sentinel (Raspberry Pi OS Bookworm, Pi 4/5).
set -euo pipefail

CONFIG=/boot/firmware/config.txt

# 1-Wire bus for the DS18B20 on GPIO4, and I2C for the LCD backpack
grep -q '^dtoverlay=w1-gpio' "$CONFIG" || echo 'dtoverlay=w1-gpio,gpiopin=4' | sudo tee -a "$CONFIG"
sudo raspi-config nonint do_i2c 0

sudo apt-get update
sudo apt-get install -y python3-venv python3-dev i2c-tools sqlite3 libgpiod2

# Service account with GPIO + I2C access, state dir for the SQLite queue
sudo useradd --system --groups gpio,i2c --home /opt/coldstore coldstore || true
sudo mkdir -p /opt/coldstore /etc/coldstore /var/lib/coldstore
sudo cp -r "$(dirname "$0")" /opt/coldstore/firmware
sudo python3 -m venv /opt/coldstore/.venv
sudo /opt/coldstore/.venv/bin/pip install -r /opt/coldstore/firmware/requirements.txt

# Device connection string from:  az iot hub device-identity connection-string show ...
if [ ! -f /etc/coldstore/iothub.env ]; then
  echo 'IOTHUB_DEVICE_CONNECTION_STRING="HostName=<hub>.azure-devices.net;DeviceId=coldstore-pi-01;SharedAccessKey=<key>"' \
    | sudo tee /etc/coldstore/iothub.env
  sudo chmod 600 /etc/coldstore/iothub.env
fi
sudo chown -R coldstore:coldstore /opt/coldstore /var/lib/coldstore

sudo cp /opt/coldstore/firmware/coldstore.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable coldstore
echo "Reboot once so the 1-Wire overlay loads, then:  journalctl -u coldstore -f"
echo "Check wiring:  ls /sys/bus/w1/devices/   and   i2cdetect -y 1   (expect 0x27)"
