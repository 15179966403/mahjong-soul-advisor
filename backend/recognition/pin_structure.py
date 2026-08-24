"""Geometric validation for circle-suit (pinzu) predictions."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import Optional, Tuple

import cv2
import numpy as np

from .preprocessing import TileFaceNormalizer


@dataclass(frozen=True)
class PinStructurePrediction:
    circle_count: int
    confidence: float
    votes: Tuple[int, ...]


class PinCircleCounter:
    """Count stable outer pip circles with multi-threshold Hough voting.

    The counter is only used when TileNet already predicts the pinzu suit. It
    is therefore an auxiliary rank check, not a standalone suit classifier.
    """

    HOUGH_THRESHOLDS = (14, 16, 18)
    MIN_CIRCLES = 2
    MAX_CIRCLES = 9

    def __init__(self, normalizer: Optional[TileFaceNormalizer] = None) -> None:
        self.normalizer = normalizer or TileFaceNormalizer()

    def predict(self, image: np.ndarray) -> Optional[PinStructurePrediction]:
        face = self.normalizer.crop_face(image).image
        normalized = self.normalizer.resize_to_height(face, height=100)
        gray = cv2.cvtColor(normalized, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (5, 5), 1)

        votes = tuple(self._count(gray, threshold) for threshold in self.HOUGH_THRESHOLDS)
        valid_votes = [
            count for count in votes if self.MIN_CIRCLES <= count <= self.MAX_CIRCLES
        ]
        if len(valid_votes) < 2:
            return None

        count, agreement = Counter(valid_votes).most_common(1)[0]
        if agreement < 2:
            return None

        # This is a stability score across detectors, not a calibrated neural
        # probability. Keep it below 1.0 even for unanimous agreement.
        confidence = 0.92 if agreement == len(self.HOUGH_THRESHOLDS) else 0.76
        return PinStructurePrediction(
            circle_count=int(count),
            confidence=confidence,
            votes=votes,
        )

    @staticmethod
    def _count(gray: np.ndarray, threshold: int) -> int:
        circles = cv2.HoughCircles(
            gray,
            cv2.HOUGH_GRADIENT,
            dp=1,
            minDist=14,
            param1=80,
            param2=threshold,
            minRadius=5,
            maxRadius=14,
        )
        return 0 if circles is None else int(len(circles[0]))
