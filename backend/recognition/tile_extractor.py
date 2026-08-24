"""Extract hand and river tile crops from Mahjong Soul screenshots.

The segmentation approach is adapted from AutoMajsoul. It deliberately keeps
image location and tile classification separate so a future model can replace
TileNet without changing the geometric pipeline.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from statistics import median
from typing import Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np


Rect = Tuple[int, int, int, int]


@dataclass(frozen=True)
class ExtractedTile:
    image: np.ndarray
    bbox: Rect
    status: Optional[str] = None


@dataclass(frozen=True)
class RiverRegion:
    position: str
    source_box: Rect
    rotation: Optional[str]


RIVER_REGIONS: Sequence[RiverRegion] = (
    RiverRegion("self", (306, 494, 185, 180), None),
    RiverRegion("right", (486, 290, 180, 207), "clockwise"),
    RiverRegion("opposite", (307, 119, 185, 180), "180"),
    RiverRegion("left", (129, 295, 180, 207), "counterclockwise"),
)


class HandTileExtractor:
    """Locate the player's concealed hand in the bottom quarter of a screenshot."""

    def __init__(self, resize_height: int = 720) -> None:
        self.resize_height = resize_height

    def extract(
        self,
        image: np.ndarray,
        debug_dir: Optional[Path] = None,
    ) -> List[ExtractedTile]:
        if image is None or image.size == 0:
            return []

        original_height, original_width = image.shape[:2]
        scale = self.resize_height / float(original_height)
        resized_width = max(1, int(round(original_width * scale)))
        resized = cv2.resize(image, (resized_width, self.resize_height))
        roi_start = int(self.resize_height * 0.75)
        roi = resized[roi_start:self.resize_height, :]

        gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        _, binary = cv2.threshold(
            gray,
            0,
            255,
            cv2.THRESH_BINARY + cv2.THRESH_OTSU,
        )
        binary = cv2.morphologyEx(
            binary,
            cv2.MORPH_OPEN,
            np.ones((3, 3), dtype=np.uint8),
        )

        contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        raw_rectangles: List[Rect] = []
        roi_height = roi.shape[0]
        for contour in sorted(contours, key=lambda item: cv2.boundingRect(item)[0]):
            x, y, width, height = cv2.boundingRect(contour)
            if height >= roi_height * 0.28 and width >= 10:
                raw_rectangles.append((x, y, width, height))

        if not raw_rectangles:
            self._write_hand_debug(debug_dir, resized, binary, roi_start, [], [], [])
            return []

        max_height = max(rect[3] for rect in raw_rectangles)
        max_bottom = max(rect[1] + rect[3] for rect in raw_rectangles)
        candidates: List[Rect] = []
        for rectangle in raw_rectangles:
            _, y, _, height = rectangle
            if height < max_height * 0.85:
                continue
            float_distance = max_bottom - (y + height)
            is_full_size = height > max_height * 0.95
            if not is_full_size and float_distance > max_height * 0.3:
                continue
            if is_full_size and float_distance > max_height * 0.8:
                continue
            candidates.append(rectangle)

        if not candidates:
            self._write_hand_debug(debug_dir, resized, binary, roi_start, raw_rectangles, [], [])
            return []

        best_cluster = self._widest_cluster(candidates)
        crops: List[np.ndarray] = []
        resized_boxes: List[Rect] = []
        original_boxes: List[Rect] = []

        for x, y, width, height in best_cluster:
            tile_count = max(1, round((width / float(height)) / 0.74))
            tile_width = width / float(tile_count)
            for index in range(tile_count):
                start_x = x + int(index * tile_width)
                end_x = x + int((index + 1) * tile_width)
                if index == tile_count - 1:
                    end_x = x + width
                crop = roi[y:y + height, start_x:end_x]
                if crop.size == 0:
                    continue

                resized_box = (start_x, y, end_x - start_x, height)
                original_box = self._to_original_box(
                    resized_box,
                    roi_start,
                    scale,
                    original_width,
                    original_height,
                )
                crops.append(crop)
                resized_boxes.append(resized_box)
                original_boxes.append(original_box)

        statuses = self._analyze_statuses(crops)
        extracted = [
            ExtractedTile(image=crop, bbox=box, status=status)
            for crop, box, status in zip(crops, original_boxes, statuses)
        ]
        self._write_hand_debug(
            debug_dir,
            resized,
            binary,
            roi_start,
            raw_rectangles,
            best_cluster,
            list(zip(resized_boxes, statuses)),
            crops,
        )
        return extracted

    @staticmethod
    def _widest_cluster(rectangles: Sequence[Rect]) -> List[Rect]:
        ordered = sorted(rectangles, key=lambda rectangle: rectangle[0])
        average_height = float(np.mean([rectangle[3] for rectangle in ordered]))
        gap_threshold = average_height * 0.75 * 1.2
        clusters: List[List[Rect]] = [[ordered[0]]]
        for rectangle in ordered[1:]:
            previous = clusters[-1][-1]
            gap = rectangle[0] - (previous[0] + previous[2])
            if gap > gap_threshold:
                clusters.append([rectangle])
            else:
                clusters[-1].append(rectangle)
        return max(
            clusters,
            key=lambda cluster: cluster[-1][0] + cluster[-1][2] - cluster[0][0],
        )

    @staticmethod
    def _analyze_statuses(crops: Sequence[np.ndarray]) -> List[str]:
        if not crops:
            return []
        brightness: List[float] = []
        for crop in crops:
            value = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)[:, :, 2]
            height, width = value.shape
            mask = np.zeros_like(value, dtype=np.uint8)
            cv2.rectangle(mask, (0, 0), (width - 1, height - 1), 255, thickness=5)
            brightness.append(float(cv2.mean(value, mask=mask)[0]))
        maximum = max(brightness)
        return ["white" if value >= maximum * 0.90 else "gray" for value in brightness]

    @staticmethod
    def _to_original_box(
        box: Rect,
        roi_start: int,
        scale: float,
        image_width: int,
        image_height: int,
    ) -> Rect:
        x, y, width, height = box
        left = max(0, int(round(x / scale)))
        top = max(0, int(round((y + roi_start) / scale)))
        right = min(image_width, int(round((x + width) / scale)))
        bottom = min(image_height, int(round((y + height + roi_start) / scale)))
        return left, top, max(1, right - left), max(1, bottom - top)

    @staticmethod
    def _write_hand_debug(
        directory: Optional[Path],
        resized: np.ndarray,
        binary: np.ndarray,
        roi_start: int,
        raw_rectangles: Sequence[Rect],
        selected_rectangles: Sequence[Rect],
        tile_boxes: Sequence[Tuple[Rect, str]],
        crops: Sequence[np.ndarray] = (),
    ) -> None:
        if directory is None:
            return
        directory.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(directory / "10_hand_binary.png"), binary)
        annotated = resized.copy()
        for rectangle in raw_rectangles:
            x, y, width, height = rectangle
            color = (0, 255, 0) if rectangle in selected_rectangles else (0, 0, 255)
            cv2.rectangle(
                annotated,
                (x, y + roi_start),
                (x + width, y + height + roi_start),
                color,
                2,
            )
        for index, (rectangle, status) in enumerate(tile_boxes):
            x, y, width, height = rectangle
            cv2.rectangle(
                annotated,
                (x, y + roi_start),
                (x + width, y + height + roi_start),
                (0, 255, 255),
                2,
            )
            cv2.putText(
                annotated,
                f"{index}:{status}",
                (x, max(15, y + roi_start - 5)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.45,
                (0, 0, 0),
                1,
            )
        cv2.imwrite(str(directory / "11_hand_annotated.png"), annotated)
        crop_directory = directory / "hand_tiles"
        crop_directory.mkdir(exist_ok=True)
        for index, crop in enumerate(crops):
            cv2.imwrite(str(crop_directory / f"tile_{index:02d}.png"), crop)


class RiverTileExtractor:
    """Extract four normalized river regions from an 800x800 warped board."""

    TILE_BACK_COLOR = (220, 223, 223)
    TILE_SUP = (225, 228, 228)

    def extract(
        self,
        warped: np.ndarray,
        debug_dir: Optional[Path] = None,
    ) -> Dict[str, List[ExtractedTile]]:
        if warped.shape[:2] != (800, 800):
            warped = cv2.resize(warped, (800, 800))

        result: Dict[str, List[ExtractedTile]] = {}
        annotated = warped.copy()
        for region in RIVER_REGIONS:
            part = self._crop_and_rotate(warped, region)
            part_tiles = self._extract_part(part)
            result[region.position] = [
                ExtractedTile(
                    image=tile.image,
                    bbox=self._part_box_to_warped(tile.bbox, region),
                )
                for tile in part_tiles
            ]

            if debug_dir is not None:
                debug_dir.mkdir(parents=True, exist_ok=True)
                cv2.imwrite(str(debug_dir / f"20_river_{region.position}.png"), part)
                part_annotated = part.copy()
                crop_dir = debug_dir / f"river_{region.position}_tiles"
                crop_dir.mkdir(exist_ok=True)
                for index, tile in enumerate(part_tiles):
                    x, y, width, height = tile.bbox
                    cv2.rectangle(
                        part_annotated,
                        (x, y),
                        (x + width, y + height),
                        (0, 255, 0),
                        2,
                    )
                    cv2.imwrite(str(crop_dir / f"tile_{index:02d}.png"), tile.image)
                cv2.imwrite(
                    str(debug_dir / f"21_river_{region.position}_annotated.png"),
                    part_annotated,
                )

            for tile in result[region.position]:
                x, y, width, height = tile.bbox
                cv2.rectangle(
                    annotated,
                    (x, y),
                    (x + width, y + height),
                    (255, 0, 255),
                    2,
                )

        if debug_dir is not None:
            cv2.imwrite(str(debug_dir / "22_rivers_annotated.png"), annotated)
        return result

    def _extract_part(self, image: np.ndarray) -> List[ExtractedTile]:
        mask = self._tile_back_mask(image)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        candidates: List[Rect] = []
        for contour in contours:
            x, y, width, height = cv2.boundingRect(contour)
            if width * height > 100 and height > 5:
                candidates.append((x, y, width, height))
        if not candidates:
            return []

        valid_areas = [width * height for _, _, width, height in candidates if width * height > 200]
        median_area = median(valid_areas) if valid_areas else 1000.0
        filtered = [
            box
            for box in candidates
            if box[2] * box[3] >= median_area * 0.8
            and 0.3 < box[2] / float(box[3]) < 3.0
        ]
        if not filtered:
            return []

        mean_width = float(np.mean([box[2] for box in filtered]))
        standard_widths = [box[2] for box in filtered if box[2] < mean_width * 1.5]
        standard_width = median(standard_widths) if standard_widths else 28.0
        if standard_width < 15:
            standard_width = 28.0

        split_boxes: List[Rect] = []
        for x, y, width, height in filtered:
            if width > standard_width * 1.6:
                tile_count = max(2, int(round(width / standard_width)))
                tile_width = width / float(tile_count)
                for index in range(tile_count):
                    start_x = x + int(index * tile_width)
                    end_x = x + int((index + 1) * tile_width)
                    if index == tile_count - 1:
                        end_x = x + width
                    split_boxes.append((start_x, y, end_x - start_x, height))
            else:
                split_boxes.append((x, y, width, height))

        rows = self._group_rows(split_boxes)
        tiles: List[ExtractedTile] = []
        for row in rows:
            for x, y, width, height in sorted(row, key=lambda box: box[0])[:6]:
                crop = image[y:y + height, x:x + width]
                if crop.size == 0:
                    continue
                classifier_crop = crop
                if width > height * 1.1:
                    classifier_crop = cv2.rotate(crop, cv2.ROTATE_90_COUNTERCLOCKWISE)
                tiles.append(ExtractedTile(classifier_crop, (x, y, width, height)))
        return tiles

    def _tile_back_mask(self, image: np.ndarray) -> np.ndarray:
        tolerance = 5
        lower = tuple(channel - tolerance for channel in self.TILE_BACK_COLOR)
        upper = tuple(channel + tolerance for channel in self.TILE_BACK_COLOR)
        exact = cv2.inRange(image, lower, upper)
        bright = cv2.inRange(image, self.TILE_SUP, (255, 255, 255))
        return cv2.bitwise_or(exact, bright)

    @staticmethod
    def _group_rows(boxes: Sequence[Rect]) -> List[List[Rect]]:
        if not boxes:
            return []
        ordered = sorted(boxes, key=lambda box: box[1])
        rows: List[List[Rect]] = [[ordered[0]]]
        row_y = ordered[0][1]
        for box in ordered[1:]:
            if abs(box[1] - row_y) < 20:
                rows[-1].append(box)
            else:
                rows.append([box])
                row_y = box[1]
        return rows

    @staticmethod
    def _crop_and_rotate(image: np.ndarray, region: RiverRegion) -> np.ndarray:
        x, y, width, height = region.source_box
        part = image[y:y + height, x:x + width].copy()
        if region.rotation == "clockwise":
            return cv2.rotate(part, cv2.ROTATE_90_CLOCKWISE)
        if region.rotation == "counterclockwise":
            return cv2.rotate(part, cv2.ROTATE_90_COUNTERCLOCKWISE)
        if region.rotation == "180":
            return cv2.rotate(part, cv2.ROTATE_180)
        return part

    @staticmethod
    def _part_box_to_warped(box: Rect, region: RiverRegion) -> Rect:
        x, y, width, height = box
        base_x, base_y, source_width, source_height = region.source_box
        if region.rotation == "clockwise":
            return (
                base_x + y,
                base_y + source_height - x - width,
                height,
                width,
            )
        if region.rotation == "counterclockwise":
            return (
                base_x + source_width - y - height,
                base_y + x,
                height,
                width,
            )
        if region.rotation == "180":
            return (
                base_x + source_width - x - width,
                base_y + source_height - y - height,
                width,
                height,
            )
        return base_x + x, base_y + y, width, height
