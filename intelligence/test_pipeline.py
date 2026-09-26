"""Small deterministic checks; no Whisper model or third-party imports."""
import ast
import os
import re
import unittest
from pathlib import Path
from threading import Lock
from types import SimpleNamespace
from unittest.mock import patch
import logging


class HTTPError(Exception):
    def __init__(self, status_code, detail):
        self.status_code, self.detail = status_code, detail
        super().__init__(detail)


def functions():
    tree = ast.parse(Path(__file__).with_name("app.py").read_text(encoding="utf-8-sig"))
    nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef)]
    for node in nodes:
        node.decorator_list = []
    module = ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[]))
    namespace = {"os": os, "re": re, "Path": Path, "SimpleNamespace": SimpleNamespace,
                 "TranscriptionRequest": SimpleNamespace, "AlignmentRequest": SimpleNamespace,
                 "HTTPException": HTTPError, "model_lock": Lock(), "logger": logging.getLogger("test")}
    exec(compile(module, "app-functions", "exec"), namespace)
    return namespace


def word(text, start, end, probability=0.9):
    return SimpleNamespace(word=text, start=start, end=end, probability=probability)


def segment(words):
    return SimpleNamespace(words=words, start=words[0].start, end=words[-1].end,
                           text="".join(item.word for item in words))


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.ns = functions()
        self.env = patch.dict(os.environ, {"WHISPER_SAMPLE_RATE": "1000", "WHISPER_FIXED_WINDOW_SECONDS": "10", "WHISPER_FIXED_WINDOW_PADDING_SECONDS": "1"})
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_window_edge_keeps_complete_owned_words(self):
        class Engine:
            def __init__(self):
                self.calls = 0

            def transcribe(self, _samples, **_options):
                self.calls += 1
                words = ([word(" antes", 9.2, 9.7), word(" borda", 9.8, 10.2), word(" depois", 10.3, 10.8)] if self.calls == 1
                         else [word(" antes", 0.2, 0.7), word(" borda", 0.8, 1.2), word(" depois", 1.3, 1.8)])
                return [segment(words)], SimpleNamespace(language="pt")
        cues, _, quality = self.ns["run_windowed_transcription"](Path("unused"), SimpleNamespace(language="pt", prompt=""), waveform=[0] * 20000, model_instance=Engine())
        self.assertEqual(" ".join(item[2] for item in cues), "antes borda depois")
        self.assertAlmostEqual(cues[1][0], 9.8)
        self.assertAlmostEqual(cues[1][1], 10.8)
        self.assertEqual(quality["measuredSegments"], 2)

    def test_local_recovery_skips_unaffected_windows(self):
        class Engine:
            calls = 0

            def transcribe(self, _samples, **_options):
                self.calls += 1
                return [segment([word(" fala", 1, 2)])], SimpleNamespace(language="pt")
        engine = Engine()
        self.ns["run_windowed_transcription"](Path("unused"), SimpleNamespace(language="pt", prompt=""), waveform=[0] * 60000, model_instance=engine, ranges=[(20, 30)])
        self.assertEqual(engine.calls, 1)

    def test_overlap_repair_keeps_different_dialogue(self):
        result = self.ns["normalize_window_cues"]([(1, 3, "primeira"), (2, 2.5, "segunda")])
        self.assertEqual(result, [(1, 3, "primeira segunda")])

    def test_ranges_are_bounded_and_include_neighbor_context(self):
        result = self.ns["recovery_ranges"]([segment([word(" fala", 21, 22)])], 100)
        self.assertEqual(result, [(10, 40)])

    def setup_endpoint(self, first, recovered=None):
        self.ns["storage_file"] = lambda *_args: Path("unused")
        self.ns["decode_audio"] = lambda *_args, **_kwargs: [0] * 160000
        self.ns["VadOptions"] = lambda **options: options
        self.ns["get_speech_timestamps"] = lambda *_args, **_kwargs: [{"start": 0, "end": 160000}]
        self.ns["run_transcription"] = lambda *_args, **_kwargs: (first, SimpleNamespace(language="pt"))
        if recovered is not None:
            self.ns["run_windowed_transcription"] = lambda *_args, **_kwargs: ([(1, 2, "recuperada")], SimpleNamespace(language="pt"), recovered)

    def test_legitimate_repetition_does_not_trigger_recovery(self):
        first = [segment([word(" uma frase repetida", i * 30, i * 30 + 2)]) for i in range(5)]
        self.setup_endpoint(first)
        self.ns["run_windowed_transcription"] = lambda *_args, **_kwargs: self.fail("repetition alone triggered inference")
        result = self.ns["transcribe"](SimpleNamespace(language="pt", prompt="", audioPath="unused"))
        self.assertIsNone(result["recoveryReason"])
        self.assertEqual(len(result["quality"]["repeatedPhraseWarning"]), 1)
        self.assertEqual(len(result["speechIntervals"]), 1)

    def test_low_confidence_is_rechecked_after_recovery(self):
        first = [segment([word(" fala", 1, 2, 0.2)])]
        quality = self.ns["transcription_quality"](first)
        self.setup_endpoint(first, quality)
        with self.assertRaisesRegex(HTTPError, "confidence remains too low"):
            self.ns["transcribe"](SimpleNamespace(language="pt", prompt="", audioPath="unused"))

    def test_moderate_recovery_confidence_is_reported(self):
        first = [segment([word(" fala", 1, 2, 0.2)])]
        quality = {"measuredSegments": 10, "averageWordProbability": 0.5, "lowConfidenceSegments": 3, "lowConfidenceRatio": 0.3, "threshold": 0.55}
        self.setup_endpoint(first, quality)
        result = self.ns["transcribe"](SimpleNamespace(language="pt", prompt="", audioPath="unused"))
        self.assertTrue(result["quality"]["confidenceWarning"])
        self.assertEqual(result["quality"]["firstPass"]["averageWordProbability"], 0.2)

    def test_invalid_negative_timing_is_recovered_without_retaining_bad_cue(self):
        first = [segment([word(" fala inválida", -1, 0, 0.9)])]
        quality = {"measuredSegments": 1, "averageWordProbability": 0.9, "lowConfidenceSegments": 0, "lowConfidenceRatio": 0, "threshold": 0.55}
        self.setup_endpoint(first, quality)
        result = self.ns["transcribe"](SimpleNamespace(language="pt", prompt="", audioPath="unused"))
        self.assertEqual(result["recoveryReason"], "abnormal-timestamps")
        self.assertNotIn("inválida", result["vtt"])


if __name__ == "__main__":
    unittest.main()
