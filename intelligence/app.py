import os
import gc
import logging
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
logger = logging.getLogger("pt-auto-intelligence")


class TranscriptionRequest(BaseModel):
    sourceId: str
    audioPath: str
    prompt: str = ""
    language: str | None = None


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


def get_model_unlocked():
    global model
    if model is None:
        model = WhisperModel(os.environ.get("WHISPER_MODEL", "small"), device=os.environ.get("WHISPER_DEVICE", "cpu"), compute_type=os.environ.get("WHISPER_COMPUTE_TYPE", "int8"))
    return model


def get_model():
    with model_lock:
        return get_model_unlocked()


def storage_file(value: str, field: str) -> Path:
    try:
        file = Path(value).resolve(strict=True)
        file.relative_to(storage_root)
        return file
    except (ValueError, FileNotFoundError):
        raise HTTPException(status_code=400, detail=f"{field} must be an existing file inside storage")


def transcription_options(recovery: bool = False):
    vad_threshold = float(os.environ.get("WHISPER_VAD_THRESHOLD", "0.35"))
    return {
        "vad_filter": True,
        "vad_parameters": {
            "threshold": max(vad_threshold, 0.45) if recovery else vad_threshold,
            "min_speech_duration_ms": int(os.environ.get("WHISPER_VAD_MIN_SPEECH_MS", "120")),
            "min_silence_duration_ms": 400 if recovery else int(os.environ.get("WHISPER_VAD_MIN_SILENCE_MS", "700")),
            "speech_pad_ms": int(os.environ.get("WHISPER_VAD_SPEECH_PAD_MS", "500")),
        },
        "beam_size": int(os.environ.get("WHISPER_BEAM_SIZE", "5")),
        "word_timestamps": True,
        "condition_on_previous_text": not recovery,
        "hallucination_silence_threshold": 1.0 if recovery else float(os.environ.get("WHISPER_HALLUCINATION_SILENCE_SECONDS", "2.0")),
        "no_speech_threshold": 0.5 if recovery else float(os.environ.get("WHISPER_NO_SPEECH_THRESHOLD", "0.6")),
    }


def run_transcription(audio: Path, request: TranscriptionRequest, recovery: bool = False):
    segments, info = get_model_unlocked().transcribe(
        str(audio),
        **transcription_options(recovery),
        language=(request.language or "").strip() or None,
        initial_prompt=request.prompt.strip() or None,
    )
    return list(segments), info


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
    # faster-whisper yields segments lazily. Keep the lock until the generator
    # is fully consumed so /unload and another transcription cannot race it.
    with model_lock:
        segments, info = run_transcription(audio, request)
        abnormal = [segment for segment in segments if float(segment.end) - float(segment.start) > 20]
        if abnormal:
            logger.warning(
                "Retrying transcription with strict silence protection: %s abnormal segments, longest %.1fs",
                len(abnormal),
                max(float(segment.end) - float(segment.start) for segment in abnormal),
            )
            # This is a fresh inference pass, not a reuse of the defective VTT.
            # Breaking prompt carry-over prevents one hallucinated phrase from
            # stretching across music or a long silent interval.
            segments, info = run_transcription(audio, request, recovery=True)
        lines = ["WEBVTT", ""]
        count = 0
        for segment in segments:
            text = segment.text.strip()
            if text:
                count += 1
                lines.extend([str(count), f"{timestamp(segment.start)} --> {timestamp(segment.end)}", text, ""])
    if count == 0:
        raise HTTPException(status_code=422, detail="no speech detected")
    return {"language": info.language or "und", "vtt": "\n".join(lines)}


@app.post("/word-timestamps")
def word_timestamps(request: AlignmentRequest):
    """Return audio-derived word boundaries for forced subtitle alignment."""
    media = storage_file(request.mediaPath, "mediaPath")
    with model_lock:
        segments, info = get_model_unlocked().transcribe(
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
