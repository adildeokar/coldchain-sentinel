"""Device health for the twin's reported properties and the getDiagnostics method."""
from __future__ import annotations

import os
import subprocess
import time

BOOT = time.time()


def cpu_temp_c() -> float | None:
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as fh:
            return int(fh.read()) / 1000.0
    except OSError:
        try:
            out = subprocess.run(["vcgencmd", "measure_temp"], capture_output=True, text=True, timeout=2).stdout
            return float(out.split("=")[1].split("'")[0])
        except Exception:
            return None


def snapshot() -> dict:
    info = {"uptimeS": int(time.time() - BOOT), "cpuTempC": cpu_temp_c(), "pid": os.getpid()}
    try:
        import psutil
        proc = psutil.Process()
        info.update({
            "cpuPct": psutil.cpu_percent(interval=None),
            "memUsedMb": round(psutil.virtual_memory().used / 2**20),
            "procRssMb": round(proc.memory_info().rss / 2**20, 1),
            "diskFreeMb": round(psutil.disk_usage("/").free / 2**20),
        })
    except ImportError:
        pass
    return info
