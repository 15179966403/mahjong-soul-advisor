from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

from backend.hand_library import evaluate_library
from backend.recognition.hand_templates import (
    HandTemplateMatcher,
    validate_hand_labels,
)


class HandTemplateMatcherTest(unittest.TestCase):
    def test_nearest_template_survives_small_brightness_change(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            library = Path(directory)
            self._write_sample(library, "1m", "source_a_00", self._one_tile())
            self._write_sample(
                library,
                "1m",
                "source_b_00",
                self._adjust_brightness(self._one_tile(), 0.94),
            )
            self._write_sample(library, "2m", "source_a_01", self._two_tile())
            self._write_sample(
                library,
                "2m",
                "source_b_01",
                self._adjust_brightness(self._two_tile(), 0.94),
            )

            matcher = HandTemplateMatcher(library)
            prediction = matcher.predict(self._adjust_brightness(self._one_tile(), 0.90))
            self.assertEqual(prediction.code, "1m")
            self.assertGreater(prediction.margin, matcher.minimum_margin)

            unknown = np.full((96, 64, 3), 238, dtype=np.uint8)
            cv2.rectangle(unknown, (0, 0), (63, 7), (100, 190, 110), -1)
            self.assertIsNone(matcher.predict(unknown).code)

            raised = np.zeros((112, 82, 3), dtype=np.uint8)
            raised[8:104, 4:68] = self._one_tile()
            prediction = matcher.predict(raised)
            self.assertEqual(prediction.code, "1m")

            evaluation = evaluate_library(matcher)
            self.assertEqual(evaluation["evaluated"], 4)
            self.assertEqual(evaluation["accuracy"], 1.0)

    def test_invalid_template_label_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "无效手牌标签"):
            validate_hand_labels(["1m", "8z"])

    def test_ambiguous_equal_templates_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            library = Path(directory)
            image = self._one_tile()
            self._write_sample(library, "1m", "source_a_00", image)
            self._write_sample(library, "2m", "source_b_00", image)
            matcher = HandTemplateMatcher(library)
            prediction = matcher.predict(image)
            self.assertIsNone(prediction.code)
            self.assertEqual(prediction.margin, 0.0)

    @staticmethod
    def _base_tile() -> np.ndarray:
        image = np.full((96, 64, 3), 238, dtype=np.uint8)
        cv2.rectangle(image, (0, 0), (63, 7), (100, 190, 110), -1)
        return image

    @classmethod
    def _one_tile(cls) -> np.ndarray:
        image = cls._base_tile()
        cv2.rectangle(image, (28, 22), (35, 70), (25, 25, 25), -1)
        cv2.rectangle(image, (24, 73), (39, 81), (20, 20, 190), -1)
        return image

    @classmethod
    def _two_tile(cls) -> np.ndarray:
        image = cls._base_tile()
        cv2.circle(image, (31, 35), 9, (25, 25, 25), -1)
        cv2.circle(image, (31, 68), 9, (25, 25, 25), -1)
        return image

    @staticmethod
    def _adjust_brightness(image: np.ndarray, factor: float) -> np.ndarray:
        return np.clip(image.astype(np.float32) * factor, 0, 255).astype(np.uint8)

    @staticmethod
    def _write_sample(
        library: Path,
        code: str,
        stem: str,
        image: np.ndarray,
    ) -> None:
        target = library / code / f"{stem}.png"
        target.parent.mkdir(parents=True, exist_ok=True)
        if not cv2.imwrite(str(target), image):
            raise OSError(target)


if __name__ == "__main__":
    unittest.main()
