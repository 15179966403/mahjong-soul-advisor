from __future__ import annotations

import unittest
from pathlib import Path

import cv2
import numpy as np

from backend.config import ApiSettings, is_loopback_host
from backend.recognition.classifier import ModelLoadError, normalize_tile_code
from backend.recognition.context_extractor import SeatWindDetector
from backend.recognition.schemas import RecognitionContext
from backend.recognition.tile_extractor import DoraIndicatorExtractor, RiverTileExtractor


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

    def test_sideways_tile_detection_uses_row_shape_outlier(self) -> None:
        clipped_riichi_row = [
            (0, 0, 22, 39),
            (23, 1, 23, 39),
            (48, 7, 29, 29),
        ]
        perspective_square_row = [
            (0, 0, 29, 30),
            (32, 0, 29, 30),
            (64, 0, 29, 30),
        ]
        self.assertEqual(
            RiverTileExtractor._sideways_indices(clipped_riichi_row),
            {2},
        )
        self.assertEqual(
            RiverTileExtractor._sideways_indices(perspective_square_row),
            set(),
        )
        self.assertEqual(
            RiverTileExtractor._sideways_indices([(0, 0, 40, 22)]),
            {0},
        )

    def test_recognition_context_serializes_riichi_for_all_seats(self) -> None:
        context = RecognitionContext(riichi={"right": True})
        self.assertEqual(
            context.to_dict()["riichi"],
            {"self": False, "right": True, "opposite": False, "left": False},
        )

    def test_dora_indicator_extractor_finds_top_left_revealed_tile(self) -> None:
        image = np.zeros((1220, 2712, 3), dtype=np.uint8)
        cv2.rectangle(image, (85, 53), (143, 139), (245, 245, 245), -1)
        cv2.rectangle(image, (148, 53), (206, 139), (140, 220, 160), -1)
        tiles = DoraIndicatorExtractor().extract(image)
        self.assertEqual(len(tiles), 1)
        self.assertEqual(tiles[0].bbox, (85, 53, 59, 87))

    def test_self_wind_is_inferred_from_dealer_marker_quadrant(self) -> None:
        cases = {
            (330, 330): "2z",
            (440, 330): "3z",
            (440, 500): "4z",
            (330, 500): "1z",
        }
        for (x, y), expected in cases.items():
            with self.subTest(expected=expected):
                warped = np.zeros((800, 800, 3), dtype=np.uint8)
                cv2.rectangle(warped, (x, y), (x + 24, y + 29), (0, 0, 210), -1)
                self.assertEqual(SeatWindDetector().detect(warped), expected)


if __name__ == "__main__":
    unittest.main()
