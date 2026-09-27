import io
import unittest
import zipfile
import re
import shutil
import tempfile
from pathlib import Path
from unittest.mock import patch
from subtitle_sync import decode_subtitle, select_payload, synchronize


def archive(files):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as output:
        for name, content in files.items():
            output.writestr(name, content)
    return stream.getvalue()


class SubtitleArchiveTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("alass-cli") and shutil.which("ffmpeg"), "ALASS integration runs in the Docker image")
    def test_alass_corrects_an_extra_thirty_second_gap_in_the_middle(self):
        def stamp(seconds):
            milliseconds = round(seconds * 1000)
            hours, rest = divmod(milliseconds, 3600000)
            minutes, rest = divmod(rest, 60000)
            whole, rest = divmod(rest, 1000)
            return f"{hours:02}:{minutes:02}:{whole:02},{rest:03}"

        cursor = 1.0
        reference, incorrect, starts = [], [], []
        for index in range(40):
            duration = 1.4 + (index * 7 % 9) * 0.31
            offset = 5 if index < 20 else 35
            starts.append(cursor)
            reference.append(f"{index + 1}\n{stamp(cursor)} --> {stamp(cursor + duration)}\nDialogue {index}.\n")
            incorrect.append(f"{index + 1}\n{stamp(cursor + offset)} --> {stamp(cursor + duration + offset)}\nDialogue {index}.\n")
            cursor += duration + 2 + (index * 11 % 7) * 0.23
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "reference.srt").write_text("\n".join(reference), encoding="utf-8")
            (root / "incorrect.srt").write_text("\n".join(incorrect), encoding="utf-8")
            result = synchronize(root / "reference.srt", root / "incorrect.srt", "incorrect.srt")
            matches = re.findall(r"(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})\s+-->", result["vtt"])
            actual = [int(h or 0) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000 for h, m, s, ms in matches]
            self.assertEqual(len(actual), 40)
            for expected, synchronized in zip(starts, actual):
                self.assertAlmostEqual(expected, synchronized, delta=0.4)

    def test_episode_pack_selects_exact_episode_without_extracting_paths(self):
        payload = archive({"../../Show.S01E02.srt": "right", "Show.S01E03.srt": "wrong"})
        content, suffix, name = select_payload(payload, "pack.zip", 1, 2)
        self.assertEqual(content, b"right")
        self.assertEqual(name, "Show.S01E02.srt")
        self.assertEqual(suffix, ".srt")

    def test_ambiguous_episode_pack_and_wrong_episode_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            select_payload(archive({"a.S01E02.srt": "a", "b.S01E02.srt": "b"}), "pack.zip", 1, 2)
        with self.assertRaisesRegex(ValueError, "matching episode"):
            select_payload(archive({"Show.S01E03.srt": "wrong"}), "pack.zip", 1, 2)

    def test_uncompressed_archive_limit_prevents_zip_bombs(self):
        payload = archive({"file.srt": "x" * 10000})
        with patch("subtitle_sync.MAX_BYTES", 1000):
            with self.assertRaisesRegex(ValueError, "size limit"):
                select_payload(payload, "file.srt")

    def test_common_portuguese_encodings_preserve_accents(self):
        for encoding in ("utf-8-sig", "utf-16", "cp1252"):
            self.assertEqual(decode_subtitle("Olá, você!".encode(encoding)), "Olá, você!")
        with self.assertRaisesRegex(ValueError, "binary"):
            decode_subtitle(b"a\x00b")


if __name__ == "__main__":
    unittest.main()
