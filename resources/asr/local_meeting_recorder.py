import argparse
import base64
import json
import os
import sys
import threading
import time
import wave

import numpy as np
import sounddevice as sd


output_lock = threading.Lock()


def emit(payload):
    with output_lock:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()


parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True)
parser.add_argument("--sample-rate", type=int, default=0)
parser.add_argument("--device", type=int, default=-1)
args = parser.parse_args()

stop_event = threading.Event()
paused = threading.Event()
selected_device = sd.query_devices(kind="input") if args.device < 0 else sd.query_devices(args.device)
sample_rate = int(args.sample_rate or selected_device["default_samplerate"])
captured_samples = 0
last_level_at = 0.0
silent_samples = 0
silence_reported = False
speech_active = False
silence_after_speech_samples = 0
speech_threshold = 0.0007
selected_channel_index = None
channel_calibration_samples = 0
channel_energy = None
# Start below the level of a quiet far-field voice.  The previous 0.001 value
# made the first few seconds of a quiet recording look like silence.
noise_floor = 0.0002
smoothed_gain = 1.0
low_input_reported = False
last_quality_at = 0.0

os.makedirs(os.path.dirname(args.output), exist_ok=True)
wav_file = wave.open(args.output, "wb")
wav_file.setnchannels(1)
wav_file.setsampwidth(2)
wav_file.setframerate(sample_rate)


def resample_to_16k(audio):
    audio = np.asarray(audio, dtype=np.float32)
    if sample_rate == 16000 or len(audio) < 2:
        return audio
    output_length = max(1, round(len(audio) * 16000 / sample_rate))
    source_positions = np.arange(len(audio), dtype=np.float64)
    target_positions = np.arange(output_length, dtype=np.float64) * sample_rate / 16000
    target_positions = np.minimum(target_positions, len(audio) - 1)
    return np.interp(target_positions, source_positions, audio).astype(np.float32)


def audio_callback(indata, frames, time_info, status):
    global captured_samples, last_level_at, silent_samples, silence_reported
    global speech_active, silence_after_speech_samples
    global selected_channel_index, channel_calibration_samples, channel_energy
    global noise_floor, smoothed_gain, low_input_reported
    global last_quality_at
    if status:
        emit({"type": "warning", "message": str(status)})
    if paused.is_set() or stop_event.is_set():
        return

    channel_data = np.asarray(indata, dtype=np.float32)
    if channel_data.ndim > 1 and channel_data.shape[1] > 1:
        channel_rms = np.sqrt(np.mean(np.square(channel_data), axis=0))
        # Array microphones commonly expose two channels.  Do not let the first
        # 100 ms (which may contain a click or speaker echo) decide the channel
        # for an entire meeting.  Use a short, mixed calibration period first.
        if selected_channel_index is None:
            if channel_energy is None:
                channel_energy = np.zeros(channel_data.shape[1], dtype=np.float64)
            channel_energy += np.square(channel_rms) * len(channel_data)
            channel_calibration_samples += len(channel_data)
            mono = np.mean(channel_data, axis=1, dtype=np.float32)
            if channel_calibration_samples >= sample_rate:
                selected_channel_index = int(np.argmax(channel_energy))
        else:
            mono = channel_data[:, selected_channel_index].copy()
    else:
        mono = channel_data.reshape(-1).copy()

    # Remove per-frame DC bias before computing voice level. USB/array mics can
    # otherwise make the recognizer interpret low-frequency rumble as speech.
    mono -= float(np.mean(mono)) if len(mono) else 0.0
    input_rms = float(np.sqrt(np.mean(np.square(mono)))) if len(mono) else 0.0
    voice_threshold = max(speech_threshold, noise_floor * 1.8)
    has_voice = input_rms >= voice_threshold
    # This is only a local UI hint. The ASR service still owns final sentence
    # boundaries, so we do not cut the audio stream and risk losing syllables.
    if has_voice:
        silence_after_speech_samples = 0
        if not speech_active:
            speech_active = True
            emit({"type": "speech_active"})
    elif speech_active:
        silence_after_speech_samples += len(mono)
        if silence_after_speech_samples >= sample_rate * 0.55:
            speech_active = False
            silence_after_speech_samples = 0
            emit({"type": "speech_pause"})

    if not has_voice:
        # Learn only from quiet frames.  This signal is intentionally used only
        # for UI/VAD hints; it must never be used as an audio gate.  Far-field
        # speech often sits below a conservative VAD threshold.
        noise_floor = 0.985 * noise_floor + 0.015 * input_rms

    # Automatic gain is deliberately independent of has_voice.  The old code
    # only boosted frames above the VAD threshold and attenuated everything
    # else, which made a distant speaker less intelligible than a nearby one.
    # Require a minimal signal above the learned room floor before boosting so
    # an empty room does not get amplified into recognizer noise.
    gain_signal_floor = max(0.00035, noise_floor * 1.15)
    if input_rms >= gain_signal_floor:
        peak = float(np.max(np.abs(mono))) if len(mono) else 0.0
        desired_gain = min(16.0, max(1.0, 0.055 / max(input_rms, 0.00035)))
        if peak > 0.0:
            desired_gain = min(desired_gain, 0.95 / peak)
    else:
        desired_gain = 1.0

    # A fast attack makes quiet speech audible promptly; a much slower release
    # prevents word endings and short pauses from audibly pumping down.
    smoothing = 0.18 if desired_gain > smoothed_gain else 0.025
    smoothed_gain += (desired_gain - smoothed_gain) * smoothing
    mono = mono * smoothed_gain
    # Soft limiting avoids the harsh clipping that otherwise creates consonant
    # distortion after a sudden loud syllable.
    mono = 0.95 * np.tanh(mono / 0.95)
    output_rms = float(np.sqrt(np.mean(np.square(mono)))) if len(mono) else 0.0

    local_pcm = np.clip(mono * 32767, -32768, 32767).astype("<i2")
    wav_file.writeframesraw(local_pcm.tobytes())
    captured_samples += len(mono)

    pcm_16k = np.clip(resample_to_16k(mono) * 32767, -32768, 32767).astype("<i2")
    emit({
        "type": "audio_chunk",
        "data": base64.b64encode(pcm_16k.tobytes()).decode("ascii"),
    })

    now = time.monotonic()
    if now - last_level_at < 0.09:
        return
    rms = float(np.sqrt(np.mean(np.square(mono)))) if len(mono) else 0.0
    emit({"type": "level", "value": min(1.0, rms * 22.0), "seconds": captured_samples / sample_rate})
    if captured_samples >= sample_rate * 4 and input_rms < 0.003 and not low_input_reported:
        low_input_reported = True
        emit({
            "type": "low_input_level",
            "message": "麦克风输入音量偏低：请靠近麦克风，或在 Windows 声音设置中提高该设备的输入音量"
        })
    if now - last_quality_at >= 1.0:
        last_quality_at = now
        emit({
            "type": "audio_quality",
            "inputRms": input_rms,
            "outputRms": output_rms,
            "gain": smoothed_gain,
            "noiseFloor": noise_floor,
            "voiceThreshold": voice_threshold,
            "hasVoice": has_voice,
            "channel": selected_channel_index or 0,
            "sampleRate": sample_rate,
        })
    last_level_at = now
    if rms < 0.00008:
        silent_samples += len(mono)
        if silent_samples >= sample_rate * 3 and not silence_reported:
            silence_reported = True
            emit({"type": "silent_input", "message": "当前麦克风没有检测到声音，请切换录音设备或检查静音开关"})
    else:
        silent_samples = 0
        silence_reported = False


try:
    input_channels = max(1, min(2, int(selected_device["max_input_channels"])))
    stream = sd.InputStream(
        device=None if args.device < 0 else args.device,
        samplerate=sample_rate,
        channels=input_channels,
        dtype="float32",
        callback=audio_callback,
        blocksize=max(800, int(sample_rate * 0.1)),
    )
    stream.start()
    emit({
        "type": "ready",
        "device": str(selected_device["name"]),
        "sampleRate": sample_rate,
        "channels": input_channels,
    })
except Exception as error:
    emit({"type": "fatal", "message": "无法打开系统麦克风：" + str(error)})
    stop_event.set()
    wav_file.close()
    sys.exit(2)

for line in sys.stdin:
    try:
        command = json.loads(line)
    except Exception:
        continue
    action = command.get("action")
    if action == "pause":
        paused.set()
        emit({"type": "paused"})
    elif action == "resume":
        paused.clear()
        emit({"type": "resumed"})
    elif action == "stop":
        break

# Streaming recognizers commonly need a short look-ahead of silence to commit
# the final phoneme.  A user pressing Stop immediately after "呢/吗/的" used to
# send an end marker with no such context, so the server could drop that last
# quiet syllable.  Keep the padding in the saved WAV too, so full-recording
# re-transcription sees the same natural sentence boundary.
stream.stop()
tail_seconds = 0.45
tail_source_samples = int(sample_rate * tail_seconds)
tail_pcm = np.zeros(tail_source_samples, dtype="<i2")
wav_file.writeframesraw(tail_pcm.tobytes())
tail_16k = np.zeros(int(16000 * tail_seconds), dtype="<i2")
emit({
    "type": "audio_chunk",
    "data": base64.b64encode(tail_16k.tobytes()).decode("ascii"),
})
if speech_active:
    emit({"type": "speech_pause"})

stop_event.set()
stream.close()
wav_file.close()
emit({
    "type": "complete",
    "audioPath": args.output,
    "durationSeconds": round(captured_samples / sample_rate),
})
