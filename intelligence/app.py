import os
import gc
import logging
import re
from pathlib import Path
from threading import Lock
from types import SimpleNamespace

import ctranslate2
from fastapi import FastAPI, HTTPException
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio
from faster_whisper.vad import get_speech_timestamps, VadOptions
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
        "chunk_length": int(os.environ.get("WHISPER_RECOVERY_CHUNK_SECONDS", "15")) if recovery else None,
        "hallucination_silence_threshold": 1.0 if recovery else float(os.environ.get("WHISPER_HALLUCINATION_SILENCE_SECONDS", "2.0")),
        "no_speech_threshold": 0.5 if recovery else float(os.environ.get("WHISPER_NO_SPEECH_THRESHOLD", "0.6")),
    }


def segment_duration(segment) -> float:
    return max(0.0, float(segment.end) - float(segment.start))


def segment_probability(segment) -> float | None:
    probabilities = [
        float(word.probability) for word in (segment.words or [])
        if getattr(word, "probability", None) is not None
    ]
    if probabilities:
        return sum(probabilities) / len(probabilities)
    return None


def transcription_quality(segments):
    threshold = float(os.environ.get("WHISPER_LOW_CONFIDENCE_THRESHOLD", "0.55"))
    measured = [value for value in (segment_probability(segment) for segment in segments) if value is not None]
    low = [value for value in measured if value < threshold]
    return {
        "measuredSegments": len(measured),
        "averageWordProbability": round(sum(measured) / len(measured), 4) if measured else None,
        "lowConfidenceSegments": len(low),
        "lowConfidenceRatio": round(len(low) / len(measured), 4) if measured else None,
        "threshold": threshold,
    }


def transcription_needs_recovery(quality) -> bool:
    average = quality.get("averageWordProbability")
    ratio = quality.get("lowConfidenceRatio")
    minimum_average = float(os.environ.get("WHISPER_RECOVERY_MIN_AVERAGE_CONFIDENCE", "0.55"))
    maximum_low_ratio = float(os.environ.get("WHISPER_RECOVERY_MAX_LOW_CONFIDENCE_RATIO", "0.25"))
    return ((average is not None and average < minimum_average)
            or (ratio is not None and ratio > maximum_low_ratio))


def suspicious_repetitions(entries, minimum_count=5, minimum_characters=12, minimum_span_seconds=90):
    """Find long identical phrases repeated across unrelated parts of a recording.

    This is only a recovery signal. Repetition alone does not prove a cue is
    false, so the first pass is never silently edited or deleted here.
    """
    groups = {}
    for entry in entries:
        start, text = (entry[0], entry[2]) if isinstance(entry, tuple) else (entry.start, entry.text)
        normalized = re.sub(r"[\W_]+", "", str(text), flags=re.UNICODE).casefold()
        if len(normalized) < minimum_characters:
            continue
        group = groups.setdefault(normalized, {"text": str(text).strip(), "count": 0, "first": float(start), "last": float(start)})
        group["count"] += 1
        group["last"] = float(start)
    return [group for group in groups.values()
            if group["count"] >= minimum_count and group["last"] - group["first"] >= minimum_span_seconds]


def suspicious_media_metadata(entries):
    """Flag filename and video-resolution strings copied from the request prompt."""
    results = []
    for entry in entries:
        text = str(entry[2] if isinstance(entry, tuple) else entry.text).strip()
        if (re.search(r"\.(?:mkv|mp4|avi|webm)(?:\b|$)", text, re.IGNORECASE)
                or re.fullmatch(r"(?:480|720|1080|1440|2160)p", text, re.IGNORECASE)):
            results.append(text)
    return results


def joined_word_text(words) -> str:
    return "".join(str(word.word or "") for word in words).strip()


def split_abnormal_segment(segment):
    """Rebuild an abnormally stretched segment from word-level timestamps.

    VAD can concatenate distant speech islands and Faster-Whisper may then map
    one short sentence across the whole concatenated interval. Word starts are
    the reliable boundaries in that case; no synthetic text is introduced.
    """
    max_seconds = float(os.environ.get("WHISPER_MAX_CUE_SECONDS", "8"))
    max_chars = int(os.environ.get("WHISPER_MAX_CUE_CHARS", "84"))
    max_gap = float(os.environ.get("WHISPER_WORD_GAP_SECONDS", "0.9"))
    words = [
        word for word in (segment.words or [])
        if word.start is not None and word.end is not None and float(word.end) > float(word.start)
    ]
    if not words:
        return []
    cues = []
    current = []

    def flush():
        nonlocal current
        if not current:
            return
        text = joined_word_text(current)
        if text:
            start = float(current[0].start)
            # A single word can inherit the same stretched end as its parent
            # segment. Cap display time while retaining its measured start.
            end = min(float(current[-1].end), start + max_seconds)
            if end > start:
                cues.append((start, end, text))
        current = []

    for word in words:
        start = float(word.start)
        end = float(word.end)
        candidate = current + [word]
        gap = start - float(current[-1].end) if current else 0.0
        too_long = bool(current) and end - float(current[0].start) > max_seconds
        too_dense = bool(current) and len(joined_word_text(candidate)) > max_chars
        if current and (gap >= max_gap or too_long or too_dense):
            flush()
        current.append(word)
        duration = min(end, float(current[0].start) + max_seconds) - float(current[0].start)
        if duration >= 1.0 and re.search(r"[.!?。！？…][\"'”’）)]?$", str(word.word or "").strip()):
            flush()
    flush()
    return cues


def safe_transcription_cues(segments):
    max_accepted = float(os.environ.get("WHISPER_ACCEPTED_SEGMENT_SECONDS", "20"))
    cues = []
    repaired = 0
    for segment in sorted(segments, key=lambda item: float(item.start)):
        text = segment.text.strip()
        if not text:
            continue
        if segment_duration(segment) <= max_accepted:
            cues.append((float(segment.start), float(segment.end), text))
            continue
        rebuilt = split_abnormal_segment(segment)
        if not rebuilt:
            raise HTTPException(status_code=422, detail="abnormal transcription segment has no usable word timestamps")
        cues.extend(rebuilt)
        repaired += 1
    if any(end - start > max_accepted for start, end, _ in cues):
        raise HTTPException(status_code=422, detail="transcription still contains abnormally long cues after word-level repair")
    return cues, repaired


def run_transcription(audio: Path, request: TranscriptionRequest, recovery: bool = False, waveform=None):
    segments, info = get_model_unlocked().transcribe(
        waveform if waveform is not None else str(audio),
        **transcription_options(recovery),
        language=(request.language or "").strip() or None,
        initial_prompt=request.prompt.strip() or None,
    )
    return list(segments), info


def normalize_window_cues(cues):
    """Return chronological, non-overlapping cues without inventing timing."""
    normalized = []
    for start, end, text in sorted(cues, key=lambda cue: (cue[0], cue[1])):
        text = text.strip()
        if not text or end <= start:
            continue
        if normalized and start < normalized[-1][1]:
            previous = normalized[-1]
            # Overlapping padded windows may recognize the same utterance twice.
            if text == previous[2] and end <= previous[1] + 1.0:
                continue
            if max(previous[1], end) - previous[0] <= 20:
                normalized[-1] = (previous[0], max(previous[1], end), f"{previous[2]} {text}")
                continue
        if end > start:
            normalized.append((start, end, text))
    return normalized


def run_windowed_transcription(audio: Path, request: TranscriptionRequest, waveform=None, model_instance=None, use_prompt=True, ranges=None):
    """Transcribe independent audio windows and restore absolute timestamps.

    A whole-file VAD pass can concatenate distant speech islands. Processing
    bounded pieces prevents a local recognition failure from shifting or
    silently dropping the following minutes of an episode.
    """
    sample_rate = int(os.environ.get("WHISPER_SAMPLE_RATE", "16000"))
    window_seconds = max(10.0, float(os.environ.get("WHISPER_FIXED_WINDOW_SECONDS", "30")))
    padding_seconds = max(0.0, min(3.0, float(os.environ.get("WHISPER_FIXED_WINDOW_PADDING_SECONDS", "1"))))
    samples = waveform if waveform is not None else decode_audio(str(audio), sampling_rate=sample_rate)
    total_seconds = len(samples) / sample_rate
    engine = model_instance or get_model_unlocked()
    options = transcription_options(recovery=True)
    # Each inference receives at most one Whisper-sized window, so global VAD
    # cannot concatenate unrelated intervals or remap their timestamps.
    options["vad_filter"] = False
    options.pop("vad_parameters", None)
    options["chunk_length"] = None
    cues = []
    measured_segments = []
    first_info = None
    core_start = 0.0
    while core_start < total_seconds:
        core_end = min(total_seconds, core_start + window_seconds)
        if ranges is not None and not any(start < core_end and end > core_start for start, end in ranges):
            core_start = core_end
            continue
        slice_start = max(0.0, core_start - padding_seconds)
        slice_end = min(total_seconds, core_end + padding_seconds)
        start_sample = round(slice_start * sample_rate)
        end_sample = round(slice_end * sample_rate)
        segments, info = engine.transcribe(
            samples[start_sample:end_sample],
            **options,
            language=(request.language or "").strip() or None,
            initial_prompt=(request.prompt.strip() or None) if use_prompt else None,
        )
        if first_info is None:
            first_info = info
        window_segments = list(segments)
        owned_segments = []
        for segment in window_segments:
            words = [word for word in (segment.words or [])
                     if word.start is not None and word.end is not None
                     and core_start <= (float(word.start) + float(word.end)) / 2 + slice_start < core_end]
            if words:
                owned_segments.append(SimpleNamespace(start=float(words[0].start), end=float(words[-1].end), text=joined_word_text(words), words=words))
            elif not segment.words:
                midpoint = (float(segment.start) + float(segment.end)) / 2 + slice_start
                if core_start <= midpoint < core_end:
                    owned_segments.append(segment)
        measured_segments.extend(owned_segments)
        relative_cues, _ = safe_transcription_cues(owned_segments)
        for start, end, text in relative_cues:
            absolute_start = start + slice_start
            absolute_end = end + slice_start
            # Ownership is selected per word. Keep measured boundaries even
            # when a word crosses the edge of its owning window.
            if absolute_end > absolute_start:
                cues.append((max(0, absolute_start), min(total_seconds, absolute_end), text))
        core_start = core_end
    return normalize_window_cues(cues), first_info, transcription_quality(measured_segments)


def recovery_ranges(segments, total_seconds, global_recovery=False):
    window = max(10.0, float(os.environ.get("WHISPER_FIXED_WINDOW_SECONDS", "30")))
    if global_recovery:
        return [(0.0, total_seconds)]
    ranges = []
    for segment in sorted(segments, key=lambda item: float(item.start)):
        start = max(0.0, (int(float(segment.start) // window) - 1) * window)
        end = min(total_seconds, (int(float(segment.end) // window) + 2) * window)
        if ranges and start <= ranges[-1][1]:
            ranges[-1] = (ranges[-1][0], max(end, ranges[-1][1]))
        else:
            ranges.append((start, end))
    return ranges


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
        sample_rate = int(os.environ.get("WHISPER_SAMPLE_RATE", "16000"))
        waveform = decode_audio(str(audio), sampling_rate=sample_rate)
        total_seconds = len(waveform) / sample_rate
        vad = transcription_options()["vad_parameters"]
        speech_intervals = [{"start": item["start"] / sample_rate, "end": item["end"] / sample_rate}
                            for item in get_speech_timestamps(waveform, VadOptions(**vad), sampling_rate=sample_rate)]
        segments, info = run_transcription(audio, request, waveform=waveform)
        abnormal = [segment for segment in segments if float(segment.end) - float(segment.start) > 20
                    or float(segment.start) < 0 or float(segment.end) <= float(segment.start) or float(segment.end) > total_seconds + 1]
        quality = transcription_quality(segments)
        low_confidence = transcription_needs_recovery(quality)
        repeated = suspicious_repetitions(segments)
        artifacts = suspicious_media_metadata(segments)
        first_quality = dict(quality)
        recovery_reason = None
        if abnormal or low_confidence or artifacts:
            recovery_reason = "abnormal-timestamps" if abnormal else "low-confidence" if low_confidence else "media-metadata"
            logger.warning(
                "Retrying transcription in independent audio windows: reason=%s, abnormal=%s, longest=%.1fs, repeated=%s, artifacts=%s, confidence=%s",
                recovery_reason,
                len(abnormal),
                max((float(segment.end) - float(segment.start) for segment in abnormal), default=0),
                [(item["text"], item["count"]) for item in repeated],
                artifacts,
                quality,
            )
            affected = [segment for segment in segments if segment in abnormal or suspicious_media_metadata([segment])]
            ranges = recovery_ranges(affected, total_seconds, global_recovery=low_confidence)
            recovered, recovery_info, recovered_quality = run_windowed_transcription(audio, request, waveform=waveform, use_prompt=False, ranges=ranges)
            retained = [segment for segment in segments if segment not in affected and not any(start <= (float(segment.start) + float(segment.end)) / 2 < end for start, end in ranges)]
            retained_cues, _ = safe_transcription_cues(retained)
            cues = normalize_window_cues(retained_cues + recovered)
            info = recovery_info or info
            retained_quality = transcription_quality(retained)
            measured = retained_quality["measuredSegments"] + recovered_quality["measuredSegments"]
            quality = {**recovered_quality, "measuredSegments": measured,
                       "averageWordProbability": (sum((item["averageWordProbability"] or 0) * item["measuredSegments"] for item in [retained_quality, recovered_quality]) / measured) if measured else None,
                       "lowConfidenceSegments": retained_quality["lowConfidenceSegments"] + recovered_quality["lowConfidenceSegments"]}
            quality["lowConfidenceRatio"] = quality["lowConfidenceSegments"] / measured if measured else None
            quality["recoveryRanges"] = ranges
            unresolved = suspicious_repetitions(cues)
            remaining_artifacts = suspicious_media_metadata(cues)
            quality["repeatedPhraseAudit"] = {"firstPass": len(repeated), "remaining": len(unresolved)}
            quality["mediaMetadataAudit"] = {"firstPass": len(artifacts), "remaining": len(remaining_artifacts)}
            if remaining_artifacts:
                raise HTTPException(status_code=422, detail="transcription artifact remains unverified after independent recovery")
            if ((quality["averageWordProbability"] is not None and quality["averageWordProbability"] < float(os.environ.get("WHISPER_REJECT_MIN_CONFIDENCE", "0.35")))
                    or (quality["lowConfidenceRatio"] is not None and quality["lowConfidenceRatio"] > float(os.environ.get("WHISPER_REJECT_MAX_LOW_CONFIDENCE_RATIO", "0.60")))):
                raise HTTPException(status_code=422, detail="transcription confidence remains too low after recovery")
            quality["confidenceWarning"] = transcription_needs_recovery(quality)
            quality["firstPass"] = first_quality
            repaired = len(abnormal) + sum(item["count"] for item in repeated) + len(artifacts)
        else:
            cues, repaired = safe_transcription_cues(segments)
        quality["repeatedPhraseWarning"] = suspicious_repetitions(cues)
        lines = ["WEBVTT", ""]
        for count, (start, end, text) in enumerate(cues, start=1):
            lines.extend([str(count), f"{timestamp(start)} --> {timestamp(end)}", text, ""])
        count = len(cues)
    if count == 0:
        raise HTTPException(status_code=422, detail="no speech detected")
    return {
        "language": info.language or request.language or "und",
        "vtt": "\n".join(lines),
        "repairedSegments": repaired,
        "recoveryReason": recovery_reason,
        "quality": quality,
        "speechIntervals": speech_intervals,
    }


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
