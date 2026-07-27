import argparse
import json
import sys
import time

import numpy as np
import sounddevice as sd


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


parser = argparse.ArgumentParser()
parser.add_argument("--device", type=int, default=-1)
parser.add_argument("--sample-rate", type=int, default=16000)
args = parser.parse_args()
last_emit = 0.0
silent_since = time.monotonic()
silence_reported = False


def callback(indata, frames, time_info, status):
    global last_emit, silent_since, silence_reported
    if status:
        emit({"type": "warning", "message": str(status)})
    now = time.monotonic()
    if now - last_emit < 0.08:
        return
    data = np.asarray(indata, dtype=np.float32)
    rms_values = np.sqrt(np.mean(np.square(data), axis=0)).reshape(-1)
    levels = [min(1.0, float(value) * 12.0) for value in rms_values]
    peak = max(levels) if levels else 0.0
    emit({"type": "test_level", "levels": levels, "peak": peak})
    last_emit = now
    if peak < 0.001:
        if now - silent_since >= 3 and not silence_reported:
            emit({"type": "test_silent", "message": "没有检测到麦克风声音"})
            silence_reported = True
    else:
        silent_since = now
        silence_reported = False


try:
    device = sd.query_devices(kind="input") if args.device < 0 else sd.query_devices(args.device)
    channels = max(1, min(2, int(device["max_input_channels"])))
    stream = sd.InputStream(
        device=None if args.device < 0 else args.device,
        samplerate=args.sample_rate,
        channels=channels,
        dtype="float32",
        callback=callback,
        blocksize=1600,
    )
    stream.start()
    emit({"type": "test_ready", "device": str(device["name"]), "channels": channels})
except Exception as error:
    emit({"type": "test_error", "message": str(error)})
    sys.exit(2)

for line in sys.stdin:
    try:
        command = json.loads(line)
    except Exception:
        continue
    if command.get("action") == "stop":
        break

stream.stop()
stream.close()
emit({"type": "test_stopped"})
