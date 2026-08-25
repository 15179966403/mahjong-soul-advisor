"""Deterministic nearest-template matching for upright concealed-hand tiles."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np

from .preprocessing import TileFaceNormalizer


HAND_TILE_CODES: Tuple[str, ...] = tuple(
    [f"{rank}{suit}" for suit in "mps" for rank in range(1, 10)]
    + [f"{rank}z" for rank in range(1, 8)]
    + ["0m", "0p", "0s"]
)
HAND_TILE_CODE_SET = frozenset(HAND_TILE_CODES)


class HandTemplateLibraryError(RuntimeError):
    """Raised when the local template library is missing or malformed."""


@dataclass(frozen=True)
class PreparedHandTemplate:
    color: np.ndarray
    foreground: np.ndarray
    red_mask: np.ndarray


@dataclass(frozen=True)
class HandTemplateSample:
    code: str
    path: Path
    source: str
    prepared: PreparedHandTemplate


@dataclass(frozen=True)
class HandTemplatePrediction:
    code: Optional[str]
    confidence: float
    distance: float
    margin: float
    template_path: Optional[Path]
    template_source: Optional[str]

    def to_dict(self) -> dict:
        payload = {
            "code": self.code,
            "confidence": round(float(self.confidence), 6),
            "distance": round(float(self.distance), 6),
            "margin": round(float(self.margin), 6),
        }
        if self.template_path is not None:
            payload["template"] = str(self.template_path)
        if self.template_source is not None:
            payload["templateSource"] = self.template_source
        return payload


class HandTemplateMatcher:
    """Match normalized upright hand tiles against confirmed local examples.

    This matcher intentionally targets only Mahjong Soul's concealed hand. It
    does not attempt to handle perspective-warped rivers, sideways tiles,
    highlights or melds. Samples are grouped by source screenshot so evaluation
    can exclude the entire source and avoid self-matching data leakage.
    """

    SIZE = 64
    MAX_DISTANCE = 0.18
    MIN_MARGIN = 0.02
    RED_FRACTION_WEIGHT = 0.90

    def __init__(
        self,
        library_dir: Path,
        maximum_distance: float = MAX_DISTANCE,
        minimum_margin: float = MIN_MARGIN,
    ) -> None:
        self.library_dir = Path(library_dir)
        self.maximum_distance = float(maximum_distance)
        self.minimum_margin = float(minimum_margin)
        self.normalizer = TileFaceNormalizer()
        self.samples = self._load_samples()
        if not self.samples:
            raise HandTemplateLibraryError(
                f"手牌模板库为空：{self.library_dir}"
            )

    def predict(
        self,
        image: np.ndarray,
        exclude_source: Optional[str] = None,
    ) -> HandTemplatePrediction:
        prepared = self.prepare(image)
        candidates = [
            sample
            for sample in self.samples
            if exclude_source is None or sample.source != exclude_source
        ]
        if not candidates:
            return HandTemplatePrediction(None, 0.0, float("inf"), 0.0, None, None)

        ranked = [
            (
                self.distance(prepared, sample.prepared),
                sample,
            )
            for sample in candidates
        ]
        ranked.sort(
            key=lambda item: (item[0], item[1].code, str(item[1].path))
        )
        best_distance, best_sample = ranked[0]
        best_by_code: Dict[str, float] = {}
        for distance, sample in ranked:
            best_by_code.setdefault(sample.code, distance)
        code_distances = sorted(best_by_code.items(), key=lambda item: item[1])
        second_distance = (
            code_distances[1][1]
            if len(code_distances) > 1
            else best_distance + 1.0
        )
        margin = max(0.0, second_distance - best_distance)
        accepted = (
            best_distance <= self.maximum_distance
            and margin >= self.minimum_margin
        )
        distance_score = max(
            0.0,
            min(1.0, 1.0 - best_distance / max(self.maximum_distance, 1e-6)),
        )
        margin_score = max(
            0.0,
            min(1.0, margin / max(self.minimum_margin * 5.0, 1e-6)),
        )
        confidence = distance_score * 0.65 + margin_score * 0.35
        return HandTemplatePrediction(
            code=best_sample.code if accepted else None,
            confidence=confidence,
            distance=best_distance,
            margin=margin,
            template_path=best_sample.path,
            template_source=best_sample.source,
        )

    def coverage(self) -> Counter[str]:
        return Counter(sample.code for sample in self.samples)

    def missing_codes(self) -> List[str]:
        coverage = self.coverage()
        return [code for code in HAND_TILE_CODES if not coverage[code]]

    def prepare(self, image: np.ndarray) -> PreparedHandTemplate:
        face = self._isolate_white_face(image)
        resized = cv2.resize(
            face,
            (self.SIZE, self.SIZE),
            interpolation=cv2.INTER_AREA,
        )
        color = resized.astype(np.float32) / 255.0
        white = np.percentile(color.reshape(-1, 3), 95, axis=0)
        color = np.clip(color / np.maximum(white, 0.4), 0.0, 1.0)
        converted = np.rint(color * 255.0).astype(np.uint8)
        gray = cv2.cvtColor(converted, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
        hsv = cv2.cvtColor(converted, cv2.COLOR_BGR2HSV)
        saturation = hsv[:, :, 1].astype(np.float32) / 255.0
        foreground = np.maximum(1.0 - gray, saturation)
        red_mask = (
            ((hsv[:, :, 0] < 12) | (hsv[:, :, 0] > 170))
            & (hsv[:, :, 1] > 50)
            & (hsv[:, :, 2] > 40)
        ).astype(np.float32)
        return PreparedHandTemplate(color, foreground, red_mask)

    def _isolate_white_face(self, image: np.ndarray) -> np.ndarray:
        """Remove green caps and dark side shadows from raised hand tiles."""

        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        white = (hsv[:, :, 1] < 75) & (hsv[:, :, 2] > 145)
        columns = np.flatnonzero(white.mean(axis=0) >= 0.28)
        rows = np.flatnonzero(white.mean(axis=1) >= 0.28)
        if columns.size and rows.size:
            left, right = int(columns[0]), int(columns[-1]) + 1
            top, bottom = int(rows[0]), int(rows[-1]) + 1
            if (
                right - left >= image.shape[1] * 0.45
                and bottom - top >= image.shape[0] * 0.45
            ):
                return image[top:bottom, left:right]
        return self.normalizer.crop_face(image).image

    @classmethod
    def distance(
        cls,
        first: PreparedHandTemplate,
        second: PreparedHandTemplate,
    ) -> float:
        weight = 0.25 + np.maximum(first.foreground, second.foreground) * 2.5
        color_difference = np.abs(first.color - second.color).mean(axis=2)
        weighted_color = float(
            (color_difference * weight).sum() / max(float(weight.sum()), 1e-6)
        )
        red_fraction_difference = abs(
            float(first.red_mask.mean()) - float(second.red_mask.mean())
        )
        return weighted_color + red_fraction_difference * cls.RED_FRACTION_WEIGHT

    def _load_samples(self) -> List[HandTemplateSample]:
        if not self.library_dir.is_dir():
            raise HandTemplateLibraryError(
                f"手牌模板库不存在：{self.library_dir}"
            )
        samples: List[HandTemplateSample] = []
        for path in sorted(self.library_dir.glob("*/*.png")):
            code = path.parent.name
            if code not in HAND_TILE_CODE_SET:
                continue
            image = cv2.imread(str(path), cv2.IMREAD_COLOR)
            if image is None or image.size == 0:
                raise HandTemplateLibraryError(f"无法读取手牌模板：{path}")
            source = self._source_from_filename(path.stem)
            samples.append(
                HandTemplateSample(
                    code=code,
                    path=path,
                    source=source,
                    prepared=self.prepare(image),
                )
            )
        return samples

    @staticmethod
    def _source_from_filename(stem: str) -> str:
        prefix, separator, index = stem.rpartition("_")
        if separator and index.isdigit():
            return prefix
        return stem


def validate_hand_labels(labels: Sequence[str]) -> None:
    invalid = [code for code in labels if code not in HAND_TILE_CODE_SET]
    if invalid:
        raise ValueError("无效手牌标签：" + "、".join(invalid))
