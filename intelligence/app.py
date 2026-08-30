import os
import gc
from pathlib import Path
from threading import Lock

import ctranslate2
from fastapi import FastAPI, HTTPException
from faster_whisper import WhisperModel
from pydantic import BaseModel

app = FastAPI(title="PT-AUTO Intelligence Worker")
storage_root = Path(os.environ.get("STORAGE_DIR", "/usr/src/app/storage")).resolve()
model = None
model_lock = Lock()


class TranscriptionRequest(BaseModel):
    sourceId: str
    audioPath: str
    prompt: str = ""


class AlignmentRequest(BaseModel):
    sourceId: str
    mediaPath: str
    language: str = "en"
    prompt: str = ""


def timestamp(seconds: float) -> str:
    millis = max(0, round(seconds * 1000))
    hours, remainder = divmod(millis, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02}:{minutes:02}:{secs:02}.{millis:03}"


def get_model():
    global model
    with model_lock:
        if model is None:
            model = WhisperModel(os.environ.get("WHISPER_MODEL", "small"), device=os.environ.get("WHISPER_DEVICE", "cpu"), compute_type=os.environ.get("WHISPER_COMPUTE_TYPE", "int8"))
    return model


def storage_file(value: str, field: str) -> Path:
    try:
        file = Path(value).resolve(strict=True)
        file.relative_to(storage_root)
        return file
    except (ValueError, FileNotFoundError):
        raise HTTPException(status_code=400, detail=f"{field} must be an existing file inside storage")


def transcription_options():
    return {
        "vad_filter": True,
        "vad_parameters": {
            "threshold": float(os.environ.get("WHISPER_VAD_THRESHOLD", "0.35")),
            "min_speech_duration_ms": int(os.environ.get("WHISPER_VAD_MIN_SPEECH_MS", "120")),
            "min_silence_duration_ms": int(os.environ.get("WHISPER_VAD_MIN_SILENCE_MS", "700")),
            "speech_pad_ms": int(os.environ.get("WHISPER_VAD_SPEECH_PAD_MS", "500")),
        },
        "beam_size": int(os.environ.get("WHISPER_BEAM_SIZE", "5")),
        "word_timestamps": True,
        "condition_on_previous_text": True,
    }


@app.get("/healthz")
def health():
    return {
        "status": "ok",
        "modelLoaded": model is not None,
        "device": os.environ.get("WHISPER_DEVICE", "cpu"),
        "computeType": os.environ.get("WHISPER_COMPUTE_TYPE", "int8"),
        "cudaDevices": ctranslate2.get_cuda_device_count(),
    }


@app.post("/unload")
def unload():
    """Release Whisper before the contextual translator claims GPU memory."""
    global model
    with model_lock:
        model = None
        gc.collect()
    return {"status": "ok", "modelLoaded": False}


@app.post("/transcribe")
def transcribe(request: TranscriptionRequest):
    audio = storage_file(request.audioPath, "audioPath")
    segments, info = get_model().transcribe(
        str(audio),
        **transcription_options(),
        initial_prompt=request.prompt.strip() or None,
    )
    lines = ["WEBVTT", ""]
    count = 0
    for count, segment in enumerate(segments, 1):
        text = segment.text.strip()
        if text:
            lines.extend([str(count), f"{timestamp(segment.start)} --> {timestamp(segment.end)}", text, ""])
    if count == 0:
        raise HTTPException(status_code=422, detail="no speech detected")
    return {"language": info.language or "und", "vtt": "\n".join(lines)}


@app.post("/word-timestamps")
def word_timestamps(request: AlignmentRequest):
    """Return audio-derived word boundaries for forced subtitle alignment."""
    media = storage_file(request.mediaPath, "mediaPath")
    segments, info = get_model().transcribe(
        str(media),
        **transcription_options(),
        language=request.language.strip() or None,
        initial_prompt=request.prompt.strip() or None,
    )
    words = []
    for segment in segments:
        for word in segment.words or []:
            text = (word.word or "").strip()
            if text and word.start is not None and word.end is not None and word.end > word.start:
                words.append({
                    "text": text,
                    "start": round(float(word.start), 3),
                    "end": round(float(word.end), 3),
                    "probability": round(float(word.probability or 0), 4),
                })
    if not words:
        raise HTTPException(status_code=422, detail="no timestamped words detected")
    return {"language": info.language or request.language or "und", "words": words}
