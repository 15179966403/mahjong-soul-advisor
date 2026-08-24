"""Normalize extracted tile crops before model and structural recognition."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Tuple

import cv2
import numpy as np


@dataclass(frozen=True)
class NormalizedTileFace:
    image: np.ndarray
    removed_top: int


class TileFaceNormalizer:
    """Remove the green tile-back strip and support aspect-safe resizing."""

    GREEN_HUE_RANGE = (25, 100)
    GREEN_MIN_SATURATION = 35
    GREEN_MIN_VALUE = 70
    GREEN_ROW_RATIO = 0.50
    TOP_SEARCH_RATIO = 0.20

    def crop_face(self, image: np.ndarray) -> NormalizedTileFace:
        self._validate(image)
        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        hue = hsv[:, :, 0]
        saturation = hsv[:, :, 1]
        value = hsv[:, :, 2]
        green = (
            (hue >= self.GREEN_HUE_RANGE[0])
            & (hue <= self.GREEN_HUE_RANGE[1])
            & (saturation >= self.GREEN_MIN_SATURATION)
            & (value >= self.GREEN_MIN_VALUE)
        )
        row_ratio = green.mean(axis=1)
        search_limit = max(1, min(image.shape[0], int(image.shape[0] * self.TOP_SEARCH_RATIO)))
        green_rows = np.flatnonzero(row_ratio[:search_limit] >= self.GREEN_ROW_RATIO)

        removed_top = 0
        if green_rows.size and green_rows[0] <= 2:
            # Only remove the leading contiguous tile-back band. Colored tile
            # artwork farther down the crop must not influence the boundary.
            last_row = int(green_rows[0])
            for row in green_rows[1:]:
                if int(row) > last_row + 1:
                    break
                last_row = int(row)
            candidate = last_row + 1
            if candidate < image.shape[0] * 0.25:
                removed_top = candidate

        face = image[removed_top:].copy()
        if face.size == 0:
            return NormalizedTileFace(image=image.copy(), removed_top=0)
        return NormalizedTileFace(image=face, removed_top=removed_top)

    def letterbox(
        self,
        image: np.ndarray,
        size: int = 64,
        background: Tuple[int, int, int] = (245, 245, 245),
    ) -> np.ndarray:
        """Resize without distorting the tile face and pad it to a square."""

        self._validate(image)
        height, width = image.shape[:2]
        scale = min(size / float(width), size / float(height))
        resized_width = max(1, min(size, int(round(width * scale))))
        resized_height = max(1, min(size, int(round(height * scale))))
        resized = cv2.resize(
            image,
            (resized_width, resized_height),
            interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC,
        )
        canvas = np.full((size, size, 3), background, dtype=np.uint8)
        left = (size - resized_width) // 2
        top = (size - resized_height) // 2
        canvas[top:top + resized_height, left:left + resized_width] = resized
        return canvas

    def resize_to_height(self, image: np.ndarray, height: int = 100) -> np.ndarray:
        """Resize while preserving aspect ratio for geometric feature detection."""

        self._validate(image)
        width = max(1, int(round(image.shape[1] * height / float(image.shape[0]))))
        return cv2.resize(
            image,
            (width, height),
            interpolation=cv2.INTER_AREA if image.shape[0] > height else cv2.INTER_CUBIC,
        )

    @staticmethod
    def _validate(image: np.ndarray) -> None:
        if image is None or image.size == 0:
            raise ValueError("Tile crop is empty")
        if image.ndim != 3 or image.shape[2] != 3:
            raise ValueError("Tile crop must be a three-channel BGR image")
