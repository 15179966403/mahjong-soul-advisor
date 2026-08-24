"""Extract round context that does not require tile classification."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional, Tuple

import cv2
import numpy as np


@dataclass(frozen=True)
class RoundWindDetection:
    code: str
    confidence: float


class RoundWindDetector:
    """Classify the cyan round-wind glyph using the bundled tile artwork."""

    def __init__(self, template_dir: Optional[Path] = None) -> None:
        if template_dir is None:
            template_dir = Path(__file__).resolve().parents[2] / "public" / "assets" / "tiles"
        self.templates: Dict[str, np.ndarray] = {}
        for code in ("1z", "2z"):
            image = cv2.imread(str(template_dir / f"{code}.png"), cv2.IMREAD_UNCHANGED)
            if image is None or image.size == 0:
                continue
            bgr = image[:, :, :3]
            hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
            blue_ink = cv2.inRange(hsv, (90, 100, 40), (140, 255, 255))
            normalized = self._normalize_glyph(blue_ink)
            if normalized is not None:
                self.templates[code] = normalized

    def detect(
        self,
        warped: np.ndarray,
        debug_dir: Optional[Path] = None,
    ) -> Optional[RoundWindDetection]:
        if warped is None or warped.size == 0 or len(self.templates) != 2:
            return None
        if warped.shape[:2] != (800, 800):
            warped = cv2.resize(warped, (800, 800))

        hsv = cv2.cvtColor(warped, cv2.COLOR_BGR2HSV)
        cyan = cv2.inRange(hsv, (70, 60, 60), (115, 255, 255))
        glyph_box = self._find_round_wind_box(cyan)
        if glyph_box is None:
            return None
        x, y, width, height = glyph_box
        glyph = self._normalize_glyph(cyan[y:y + height, x:x + width])
        if glyph is None:
            return None

        scores = {
            code: self._glyph_distance(glyph, template)
            for code, template in self.templates.items()
        }
        ordered = sorted(scores.items(), key=lambda item: item[1])
        best_code, best_score = ordered[0]
        second_score = ordered[1][1]
        relative_margin = max(0.0, (second_score - best_score) / max(second_score, 1e-6))
        confidence = min(0.99, 0.50 + relative_margin)
        detection = RoundWindDetection(best_code, confidence)

        if debug_dir is not None:
            debug_dir.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(debug_dir / "32_context_cyan_mask.png"), cyan)
            cv2.imwrite(str(debug_dir / "33_round_wind_glyph.png"), glyph)
            annotated = warped.copy()
            cv2.rectangle(
                annotated,
                (x, y),
                (x + width, y + height),
                (0, 255, 255),
                2,
            )
            cv2.putText(
                annotated,
                f"round={best_code} {confidence:.2f}",
                (x, max(18, y - 6)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.45,
                (0, 255, 255),
                1,
            )
            cv2.imwrite(str(debug_dir / "34_round_wind_annotated.png"), annotated)
        return detection

    @staticmethod
    def _find_round_wind_box(mask: np.ndarray) -> Optional[Tuple[int, int, int, int]]:
        roi_left, roi_top, roi_right, roi_bottom = 330, 350, 470, 430
        roi = mask[roi_top:roi_bottom, roi_left:roi_right]
        contours, _ = cv2.findContours(
            roi,
            cv2.RETR_EXTERNAL,
            cv2.CHAIN_APPROX_SIMPLE,
        )
        candidates = []
        for contour in contours:
            x, y, width, height = cv2.boundingRect(contour)
            area = float(cv2.contourArea(contour))
            if 5 <= width <= 18 and 20 <= height <= 30 and area >= 45:
                candidates.append(
                    (x + roi_left, y + roi_top, width, height, area)
                )
        if not candidates:
            return None

        rows: list[list[Tuple[int, int, int, int, float]]] = []
        for candidate in sorted(candidates, key=lambda item: item[1] + item[3] / 2.0):
            center_y = candidate[1] + candidate[3] / 2.0
            target = next(
                (
                    row
                    for row in rows
                    if abs(
                        center_y
                        - np.mean([item[1] + item[3] / 2.0 for item in row])
                    ) <= 5.0
                ),
                None,
            )
            if target is None:
                rows.append([candidate])
            else:
                target.append(candidate)

        text_rows = [row for row in rows if len(row) >= 2]
        selected_row = max(
            text_rows or rows,
            key=lambda row: (len(row), sum(item[4] for item in row)),
        )
        x, y, width, height, _ = min(selected_row, key=lambda item: item[0])
        return x, y, width, height

    @staticmethod
    def _normalize_glyph(mask: np.ndarray, size: int = 64) -> Optional[np.ndarray]:
        contours, _ = cv2.findContours(
            mask,
            cv2.RETR_EXTERNAL,
            cv2.CHAIN_APPROX_SIMPLE,
        )
        if not contours:
            return None
        contour = max(contours, key=cv2.contourArea)
        x, y, width, height = cv2.boundingRect(contour)
        if width <= 0 or height <= 0:
            return None
        crop = mask[y:y + height, x:x + width]
        scale = min((size - 8) / float(width), (size - 8) / float(height))
        resized_width = max(1, int(round(width * scale)))
        resized_height = max(1, int(round(height * scale)))
        resized = cv2.resize(
            crop,
            (resized_width, resized_height),
            interpolation=cv2.INTER_NEAREST,
        )
        normalized = np.zeros((size, size), dtype=np.uint8)
        offset_x = (size - resized_width) // 2
        offset_y = (size - resized_height) // 2
        normalized[
            offset_y:offset_y + resized_height,
            offset_x:offset_x + resized_width,
        ] = resized
        return normalized

    @staticmethod
    def _glyph_distance(glyph: np.ndarray, template: np.ndarray) -> float:
        glyph_distance = cv2.distanceTransform(
            255 - glyph,
            cv2.DIST_L2,
            3,
        )
        template_distance = cv2.distanceTransform(
            255 - template,
            cv2.DIST_L2,
            3,
        )
        glyph_points = glyph > 0
        template_points = template > 0
        if not glyph_points.any() or not template_points.any():
            return float("inf")
        chamfer = float(
            (
                template_distance[glyph_points].mean()
                + glyph_distance[template_points].mean()
            )
            / 2.0
        )
        glyph_contours, _ = cv2.findContours(
            glyph,
            cv2.RETR_EXTERNAL,
            cv2.CHAIN_APPROX_SIMPLE,
        )
        template_contours, _ = cv2.findContours(
            template,
            cv2.RETR_EXTERNAL,
            cv2.CHAIN_APPROX_SIMPLE,
        )
        glyph_contour = max(glyph_contours, key=cv2.contourArea)
        template_contour = max(template_contours, key=cv2.contourArea)
        moment_distance = cv2.matchShapes(
            glyph_contour,
            template_contour,
            cv2.CONTOURS_MATCH_I2,
            0.0,
        )
        return chamfer + float(moment_distance) * 0.15


class SeatWindDetector:
    """Infer the player's wind from the dealer marker around the score panel."""

    # Once every board is normalized to 800x800, the four wind markers occupy
    # one quadrant each around the score panel. The red marker is always East
    # (the dealer), so its seat relative to the bottom player determines the
    # bottom player's current wind.
    WIND_BY_DEALER_QUADRANT = {
        (False, False): "2z",  # dealer at left -> self is South
        (True, False): "3z",   # dealer opposite -> self is West
        (True, True): "4z",    # dealer at right -> self is North
        (False, True): "1z",   # self is dealer -> self is East
    }

    def detect(
        self,
        warped: np.ndarray,
        debug_dir: Optional[Path] = None,
    ) -> Optional[str]:
        if warped is None or warped.size == 0:
            return None
        if warped.shape[:2] != (800, 800):
            warped = cv2.resize(warped, (800, 800))

        hsv = cv2.cvtColor(warped, cv2.COLOR_BGR2HSV)
        lower_red = cv2.inRange(hsv, (0, 100, 70), (12, 255, 255))
        upper_red = cv2.inRange(hsv, (165, 100, 70), (180, 255, 255))
        red_mask = cv2.bitwise_or(lower_red, upper_red)

        central = red_mask[250:610, 250:550]
        contours, _ = cv2.findContours(
            central,
            cv2.RETR_EXTERNAL,
            cv2.CHAIN_APPROX_SIMPLE,
        )
        candidates = []
        for contour in contours:
            x, y, width, height = cv2.boundingRect(contour)
            area = float(cv2.contourArea(contour))
            fill = area / float(max(1, width * height))
            if (
                15 <= width <= 42
                and 18 <= height <= 42
                and area >= 250
                and fill >= 0.55
            ):
                candidates.append((area, x + 250, y + 250, width, height))

        selected = max(candidates, default=None)
        self_wind = None
        if selected is not None:
            _, x, y, width, height = selected
            center_x = x + width / 2.0
            center_y = y + height / 2.0
            quadrant = (center_x >= 400.0, center_y >= 430.0)
            self_wind = self.WIND_BY_DEALER_QUADRANT[quadrant]

        if debug_dir is not None:
            debug_dir.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(debug_dir / "30_context_red_mask.png"), red_mask)
            annotated = warped.copy()
            for _, x, y, width, height in candidates:
                cv2.rectangle(
                    annotated,
                    (x, y),
                    (x + width, y + height),
                    (0, 255, 255),
                    2,
                )
            if selected is not None:
                _, x, y, width, height = selected
                cv2.rectangle(
                    annotated,
                    (x, y),
                    (x + width, y + height),
                    (0, 255, 0),
                    2,
                )
                cv2.putText(
                    annotated,
                    f"self={self_wind}",
                    (x, max(18, y - 6)),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.5,
                    (0, 255, 0),
                    1,
                )
            cv2.imwrite(str(debug_dir / "31_context_annotated.png"), annotated)
        return self_wind
