"""Extract round context that does not require tile classification."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

import cv2
import numpy as np


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
