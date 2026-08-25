from __future__ import annotations

import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np

from backend.config import ApiSettings, is_loopback_host
from backend.recognition.classifier import (
    ModelLoadError,
    TileClassifier,
    normalize_tile_code,
)
from backend.recognition.context_extractor import RoundWindDetector, SeatWindDetector
from backend.recognition.schemas import BoundingBox, RecognitionContext, TilePrediction
from backend.recognition.tile_extractor import (
    DoraIndicatorExtractor,
    HandTileExtractor,
    RiverTileExtractor,
)


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

    def test_hand_template_library_environment_flag(self) -> None:
        with patch.dict(
            "os.environ",
            {
                "MAHJONG_HAND_TEMPLATE_LIBRARY_ENABLED": "true",
                "MAHJONG_HAND_TEMPLATE_LIBRARY_DIR": "/tmp/hand-templates",
            },
            clear=True,
        ):
            settings = ApiSettings.from_environment()
        self.assertTrue(settings.hand_template_library_enabled)
        self.assertEqual(
            settings.hand_template_library_dir,
            Path("/tmp/hand-templates"),
        )

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

    def test_self_river_region_keeps_leftmost_tile(self) -> None:
        warped = np.zeros((800, 800, 3), dtype=np.uint8)
        cv2.rectangle(warped, (295, 503), (317, 540), (235, 235, 235), -1)
        tiles = RiverTileExtractor().extract(warped)["self"]
        self.assertEqual(len(tiles), 1)
        self.assertEqual(tiles[0].bbox, (295, 503, 23, 38))

    def test_center_crop_consensus_is_limited_to_manzu(self) -> None:
        self.assertTrue(TileClassifier._should_use_center_crop_consensus("4m", 0.2))
        self.assertFalse(TileClassifier._should_use_center_crop_consensus("5p", 0.2))
        self.assertFalse(TileClassifier._should_use_center_crop_consensus("1p", 0.2))

    def test_hand_extractor_keeps_row_with_one_raised_large_tile(self) -> None:
        image = np.zeros((720, 1280, 3), dtype=np.uint8)
        for index in range(12):
            left = 250 + index * 64
            cv2.rectangle(image, (left, 614), (left + 60, 714), (238, 238, 238), -1)
        cv2.rectangle(image, (1018, 591), (1096, 714), (238, 238, 238), -1)
        tiles = HandTileExtractor().extract(image)
        self.assertEqual(len(tiles), 13)

    def test_recognition_context_serializes_riichi_for_all_seats(self) -> None:
        context = RecognitionContext(
            riichi={"right": True},
            round_wind="1z",
            round_wind_confidence=0.842163,
        )
        self.assertEqual(
            context.to_dict()["riichi"],
            {"self": False, "right": True, "opposite": False, "left": False},
        )
        self.assertEqual(context.to_dict()["roundWind"], "1z")
        self.assertEqual(context.to_dict()["roundWindConfidence"], 0.842163)

    def test_template_match_details_are_serialized(self) -> None:
        tile = TilePrediction(
            code="7p",
            confidence=0.94,
            bbox=BoundingBox(1, 2, 3, 4),
            model_code="6p",
            model_confidence=0.31,
            decision_source="hand-template-library",
            template_distance=0.0123,
            template_margin=0.2456,
            template_source="340",
        )
        recognition = tile.to_dict()["recognition"]
        self.assertEqual(recognition["source"], "hand-template-library")
        self.assertEqual(recognition["templateSource"], "340")
        self.assertEqual(recognition["templateDistance"], 0.0123)

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

    def test_round_wind_uses_cyan_glyph_shape(self) -> None:
        detector = RoundWindDetector()
        self.assertEqual(set(detector.templates), {"1z", "2z"})
        for expected, template in detector.templates.items():
            with self.subTest(expected=expected):
                warped = np.zeros((800, 800, 3), dtype=np.uint8)
                glyph = cv2.resize(template, (12, 24), interpolation=cv2.INTER_NEAREST)
                glyph_region = warped[380:404, 370:382]
                glyph_region[glyph > 0] = (255, 220, 0)
                cv2.rectangle(warped, (388, 380), (397, 403), (255, 220, 0), -1)
                cv2.rectangle(warped, (403, 380), (412, 403), (255, 220, 0), -1)
                detection = detector.detect(warped)
                self.assertIsNotNone(detection)
                self.assertEqual(detection.code, expected)
                self.assertGreaterEqual(detection.confidence, 0.5)


if __name__ == "__main__":
    unittest.main()
