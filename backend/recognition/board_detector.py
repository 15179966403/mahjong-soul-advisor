"""Detect and normalize the Mahjong Soul table from a full screenshot."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Tuple

import cv2
import numpy as np


class TableNotFoundError(RuntimeError):
    """Raised when no reliable Mahjong table quadrilateral can be found."""


@dataclass(frozen=True)
class TableDetection:
    quad: np.ndarray
    method: str


class BoardDetector:
    SAMPLE_FRAC = 0.10
    DELTA_H = 15
    DELTA_SV = 60
    MIN_TABLE_AREA_RATIO = 0.22
    APPROX_EPS_FRAC = 0.02
    APPROX_EPS_CANDIDATES = (0.02, 0.025, 0.03, 0.04, 0.05, 0.015, 0.01)
    AGGRESSIVE_EPS_CANDIDATES = (0.055, 0.06)
    WARP_SIZE = 800

    def detect(
        self,
        image: np.ndarray,
        debug_dir: Optional[Path] = None,
    ) -> TableDetection:
        self._validate_image(image)
        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        mask = self._table_mask_by_color(hsv)
        image_area = image.shape[0] * image.shape[1]
        quad = self._find_quad(mask, image_area)
        method = "color"

        if debug_dir is not None:
            self._write_debug_image(debug_dir, "01_table_mask.png", mask)

        if quad is None:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            edges = cv2.Canny(gray, 50, 150)
            edges = cv2.dilate(edges, None, iterations=2)
            quad = self._find_quad(edges, image_area)
            method = "edges"
            if debug_dir is not None:
                self._write_debug_image(debug_dir, "02_table_edges.png", edges)

        if quad is None:
            raise TableNotFoundError("未能在截图中定位雀魂牌桌")

        if debug_dir is not None:
            annotated = image.copy()
            points = quad.astype(np.int32)
            cv2.polylines(annotated, [points], True, (0, 255, 0), 3)
            for label, point in zip(("TL", "TR", "BL", "BR"), points):
                x, y = int(point[0]), int(point[1])
                cv2.circle(annotated, (x, y), 8, (255, 0, 0), -1)
                cv2.putText(
                    annotated,
                    label,
                    (x + 10, y),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.6,
                    (255, 0, 0),
                    2,
                )
            self._write_debug_image(debug_dir, "03_table_quad.png", annotated)

        return TableDetection(quad=quad, method=method)

    def warp(
        self,
        image: np.ndarray,
        quad: np.ndarray,
    ) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
        size = self.WARP_SIZE
        destination = np.array(
            [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]],
            dtype=np.float32,
        )
        matrix = cv2.getPerspectiveTransform(quad.astype(np.float32), destination)
        inverse = cv2.getPerspectiveTransform(destination, quad.astype(np.float32))
        warped = cv2.warpPerspective(image, matrix, (size, size))
        return warped, matrix, inverse

    @staticmethod
    def project_box_to_original(
        box: Tuple[int, int, int, int],
        inverse_matrix: np.ndarray,
        image_width: int,
        image_height: int,
    ) -> Tuple[int, int, int, int]:
        x, y, width, height = box
        corners = np.array(
            [[[x, y], [x + width, y], [x + width, y + height], [x, y + height]]],
            dtype=np.float32,
        )
        projected = cv2.perspectiveTransform(corners, inverse_matrix)[0]
        min_x = max(0, int(np.floor(projected[:, 0].min())))
        min_y = max(0, int(np.floor(projected[:, 1].min())))
        max_x = min(image_width, int(np.ceil(projected[:, 0].max())))
        max_y = min(image_height, int(np.ceil(projected[:, 1].max())))
        return min_x, min_y, max(1, max_x - min_x), max(1, max_y - min_y)

    def _table_mask_by_color(self, hsv: np.ndarray) -> np.ndarray:
        height, width = hsv.shape[:2]
        center_y, center_x = height // 2, width // 2
        sample_x = int(center_x - width * 0.25)
        sample_y = center_y
        half_height = max(1, int(height * self.SAMPLE_FRAC / 2))
        half_width = max(1, int(width * self.SAMPLE_FRAC / 2))
        y1, y2 = max(0, sample_y - half_height), min(height, sample_y + half_height)
        x1, x2 = max(0, sample_x - half_width), min(width, sample_x + half_width)
        sample = hsv[y1:y2, x1:x2]

        if sample.size == 0:
            sample = hsv[
                max(0, center_y - half_height):min(height, center_y + half_height),
                max(0, center_x - half_width):min(width, center_x + half_width),
            ]
        if sample.size == 0:
            return np.zeros((height, width), dtype=np.uint8)

        mean_h, mean_s, mean_v = np.mean(sample.reshape(-1, 3), axis=0)
        lower = np.array(
            [
                max(0, mean_h - self.DELTA_H),
                max(0, mean_s - self.DELTA_SV),
                max(0, mean_v - self.DELTA_SV),
            ],
            dtype=np.uint8,
        )
        upper = np.array(
            [
                min(179, mean_h + self.DELTA_H),
                min(255, mean_s + self.DELTA_SV),
                min(255, mean_v + self.DELTA_SV),
            ],
            dtype=np.uint8,
        )
        mask = cv2.inRange(hsv, lower, upper)
        return cv2.morphologyEx(
            mask,
            cv2.MORPH_CLOSE,
            np.ones((7, 7), dtype=np.uint8),
            iterations=3,
        )

    def _find_quad(self, mask: np.ndarray, image_area: int) -> Optional[np.ndarray]:
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            return None

        contour = max(contours, key=cv2.contourArea)
        if cv2.contourArea(contour) < self.MIN_TABLE_AREA_RATIO * image_area:
            return None

        # Prefer the original contour because it preserves the table boundary
        # most accurately on stable screenshots.
        quad = self._approximate_quad(
            contour,
            mask.shape,
            image_area,
            self.APPROX_EPS_CANDIDATES,
        )
        if quad is not None:
            return quad

        # Animations, floating tiles and table skins can cut notches into the
        # color mask. The convex hull removes those local concavities before
        # fitting a quadrilateral.
        hull = cv2.convexHull(contour)
        quad = self._approximate_quad(
            hull,
            mask.shape,
            image_area,
            self.APPROX_EPS_CANDIDATES,
        )
        if quad is not None:
            return quad

        # Last resort for contours that remain slightly over-segmented. These
        # candidates still have to pass the same geometric validation.
        return self._approximate_quad(
            contour,
            mask.shape,
            image_area,
            self.AGGRESSIVE_EPS_CANDIDATES,
        )

    def _approximate_quad(
        self,
        contour: np.ndarray,
        image_shape: Tuple[int, int],
        image_area: int,
        epsilon_candidates: Tuple[float, ...],
    ) -> Optional[np.ndarray]:
        perimeter = cv2.arcLength(contour, True)
        if perimeter <= 0:
            return None

        for epsilon in epsilon_candidates:
            approximation = cv2.approxPolyDP(contour, epsilon * perimeter, True)
            if len(approximation) != 4:
                continue
            ordered = self._order_quad(
                approximation.reshape(4, 2).astype(np.float32)
            )
            if self._is_valid_quad(ordered, image_shape, image_area):
                return ordered
        return None

    def _is_valid_quad(
        self,
        quad: np.ndarray,
        image_shape: Tuple[int, int],
        image_area: int,
    ) -> bool:
        height, width = image_shape[:2]
        if quad.shape != (4, 2) or not np.isfinite(quad).all():
            return False

        # _order_quad stores TL, TR, BL, BR. OpenCV polygon operations require
        # clockwise/counter-clockwise order, hence TL, TR, BR, BL here.
        polygon = quad[[0, 1, 3, 2]].reshape(-1, 1, 2).astype(np.float32)
        if not cv2.isContourConvex(polygon):
            return False

        area = abs(cv2.contourArea(polygon))
        if area < self.MIN_TABLE_AREA_RATIO * image_area or area > image_area * 0.98:
            return False

        horizontal_span = float(np.ptp(quad[:, 0]))
        vertical_span = float(np.ptp(quad[:, 1]))
        if horizontal_span < width * 0.50 or vertical_span < height * 0.50:
            return False

        top_width = float(np.linalg.norm(quad[1] - quad[0]))
        bottom_width = float(np.linalg.norm(quad[3] - quad[2]))
        left_height = float(np.linalg.norm(quad[2] - quad[0]))
        right_height = float(np.linalg.norm(quad[3] - quad[1]))
        if min(top_width, bottom_width) < width * 0.20:
            return False
        if min(left_height, right_height) < height * 0.35:
            return False

        # The Mahjong Soul table is rendered in perspective: its lower edge is
        # normally at least as wide as its upper edge. Keep some tolerance for
        # cropped screenshots and different device aspect ratios.
        if bottom_width < top_width * 0.85:
            return False
        return True

    @staticmethod
    def _order_quad(quad: np.ndarray) -> np.ndarray:
        sums = quad.sum(axis=1)
        differences = np.diff(quad, axis=1).ravel()
        ordered = np.zeros((4, 2), dtype=np.float32)
        ordered[0] = quad[np.argmin(sums)]
        ordered[3] = quad[np.argmax(sums)]
        ordered[1] = quad[np.argmin(differences)]
        ordered[2] = quad[np.argmax(differences)]
        return ordered

    @staticmethod
    def _validate_image(image: np.ndarray) -> None:
        if image is None or image.size == 0:
            raise ValueError("Screenshot is empty")
        if image.ndim != 3 or image.shape[2] != 3:
            raise ValueError("Screenshot must be a three-channel BGR image")

    @staticmethod
    def _write_debug_image(directory: Path, name: str, image: np.ndarray) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(directory / name), image)
