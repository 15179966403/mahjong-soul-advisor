from __future__ import annotations

import unittest
from pathlib import Path

from backend.config import ApiSettings, is_loopback_host
from backend.recognition.classifier import ModelLoadError, normalize_tile_code


class RecognitionCoreTest(unittest.TestCase):
    def test_tile_labels_are_normalized_for_advisor_notation(self) -> None:
        self.assertEqual(normalize_tile_code("m5"), "5m")
        self.assertEqual(normalize_tile_code("red5p"), "0p")
        self.assertIsNone(normalize_tile_code("x"))
        with self.assertRaises(ModelLoadError):
            normalize_tile_code("10m")

    def test_api_binding_is_loopback_only(self) -> None:
        self.assertTrue(is_loopback_host("127.0.0.1"))
        self.assertTrue(is_loopback_host("::1"))
        self.assertFalse(is_loopback_host("0.0.0.0"))
        with self.assertRaisesRegex(ValueError, "loopback"):
            ApiSettings(host="0.0.0.0").validate()

    def test_default_model_and_limits_validate(self) -> None:
        settings = ApiSettings(model_path=Path("backend/models/best_model.pt")).validate()
        self.assertEqual(settings.port, 8765)
        self.assertGreater(settings.max_upload_bytes, 0)
        self.assertGreater(settings.recognition_timeout_seconds, 0)


if __name__ == "__main__":
    unittest.main()
