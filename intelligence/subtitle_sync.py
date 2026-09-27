"""Bounded subtitle decoding and synchronization; never extracts archive paths."""
import io
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path

MAX_BYTES = 16 * 1024 * 1024
FORMATS = {".srt", ".vtt", ".ass", ".ssa"}
EPISODE = re.compile(r"(?i)(?:s(\d{1,2})[ ._-]*e(\d{1,3})|(\d{1,2})x(\d{1,3}))")


def decode_subtitle(payload):
    if len(payload) > MAX_BYTES:
        raise ValueError("subtitle exceeds size limit")
    if payload.startswith((b"\xff\xfe", b"\xfe\xff")):
        return payload.decode("utf-16")
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            text = payload.decode(encoding)
            if "\x00" in text:
                raise ValueError("binary subtitle is unsupported")
            return text
        except UnicodeDecodeError:
            continue
    raise ValueError("unsupported subtitle encoding")


def select_payload(payload, file_name, season=None, episode=None):
    if len(payload) > MAX_BYTES:
        raise ValueError("subtitle exceeds size limit")
    if not zipfile.is_zipfile(io.BytesIO(payload)):
        suffix = Path(file_name).suffix.lower()
        if suffix not in FORMATS:
            suffix = ".srt"
        return payload, suffix, Path(file_name).name
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        entries = archive.infolist()
        if len(entries) > 200 or sum(entry.file_size for entry in entries) > MAX_BYTES:
            raise ValueError("subtitle archive exceeds size limit")
        files = [entry for entry in entries if not entry.is_dir() and Path(entry.filename).suffix.lower() in FORMATS]
        if season is not None and episode is not None:
            identified = []
            for entry in files:
                match = EPISODE.search(Path(entry.filename).name)
                if match:
                    s, e = (match[1], match[2]) if match[1] else (match[3], match[4])
                    if int(s) == season and int(e) == episode:
                        identified.append(entry)
            if identified:
                files = identified
            elif len(files) != 1 or EPISODE.search(Path(files[0].filename).name):
                raise ValueError("archive has no unambiguous matching episode")
        if len(files) != 1:
            exact = [entry for entry in files if Path(entry.filename).name == Path(file_name).name]
            if len(exact) != 1:
                raise ValueError("archive contains ambiguous subtitle variants")
            files = exact
        entry = files[0]
        if entry.flag_bits & 1:
            raise ValueError("encrypted subtitles are unsupported")
        # Read in memory; filenames are never used as extraction destinations.
        return archive.read(entry), Path(entry.filename).suffix.lower(), Path(entry.filename).name


def run(arguments, timeout):
    result = subprocess.run(arguments, capture_output=True, timeout=timeout, check=False)
    if result.returncode:
        raise ValueError(f"{arguments[0]} subtitle conversion or synchronization failed")


def synchronize(audio_path, subtitle_path, file_name, season=None, episode=None, timeout=600):
    payload, suffix, member = select_payload(Path(subtitle_path).read_bytes(), file_name, season, episode)
    text = decode_subtitle(payload)
    with tempfile.TemporaryDirectory(prefix="subtitle-sync-", dir=Path(subtitle_path).parent) as directory:
        root = Path(directory)
        decoded = root / f"decoded{suffix}"
        decoded.write_text(text, encoding="utf-8")
        original = root / "original.srt"
        aligned = root / "aligned.srt"
        raw_vtt = root / "original.vtt"
        final_vtt = root / "aligned.vtt"
        run(["ffmpeg", "-nostdin", "-y", "-v", "error", "-i", str(decoded), str(original)], 60)
        run(["ffmpeg", "-nostdin", "-y", "-v", "error", "-i", str(original), str(raw_vtt)], 60)
        run(["alass-cli", str(audio_path), str(original), str(aligned), "--split-penalty", "7"], timeout)
        run(["ffmpeg", "-nostdin", "-y", "-v", "error", "-i", str(aligned), str(final_vtt)], 60)
        if max(raw_vtt.stat().st_size, final_vtt.stat().st_size) > MAX_BYTES:
            raise ValueError("synchronized subtitle exceeds size limit")
        return {"rawVtt": raw_vtt.read_text(encoding="utf-8"), "vtt": final_vtt.read_text(encoding="utf-8"),
                "method": "alass", "sourceMember": member}
