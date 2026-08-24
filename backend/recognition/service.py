"""Orchestrate screenshot loading, geometry, tile extraction and classification."""

from __future__ import annotations

from collections import Counter
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from .board_detector import BoardDetector, TableNotFoundError
from .classifier import ModelLoadError, TileClassifier
from .schemas import (
    BoundingBox,
    ImageInfo,
    RecognitionResult,
    TableInfo,
    TilePrediction,
)
from .tile_extractor import ExtractedTile, HandTileExtractor, RiverTileExtractor


class RecognitionError(RuntimeError):
    """Stable error carrying a machine-readable code for the CLI and future API."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class RecognitionService:
    def __init__(
        self,
        model_path: Path,
        device: str = "auto",
        minimum_confidence: float = 0.65,
    ) -> None:
        if not 0.0 <= minimum_confidence <= 1.0:
            raise ValueError("minimum_confidence must be between 0 and 1")
        self.minimum_confidence = minimum_confidence
        self.board_detector = BoardDetector()
        self.hand_extractor = HandTileExtractor()
        self.river_extractor = RiverTileExtractor()
        try:
            self.classifier = TileClassifier(model_path=model_path, device=device)
        except ModelLoadError as exc:
            raise RecognitionError("MODEL_LOAD_FAILED", str(exc)) from exc

    def recognize_path(
        self,
        image_path: Path,
        debug_dir: Optional[Path] = None,
    ) -> RecognitionResult:
        image = self._load_image(image_path)
        return self.recognize_image(image, debug_dir=debug_dir)

    def recognize_image(
        self,
        image: np.ndarray,
        debug_dir: Optional[Path] = None,
    ) -> RecognitionResult:
        if image is None or image.size == 0:
            raise RecognitionError("INVALID_IMAGE", "截图为空")
        if image.ndim != 3 or image.shape[2] != 3:
            raise RecognitionError("INVALID_IMAGE", "截图必须是三通道彩色图片")

        if debug_dir is not None:
            debug_dir.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(debug_dir / "00_original.png"), image)

        try:
            table = self.board_detector.detect(image, debug_dir=debug_dir)
        except TableNotFoundError as exc:
            raise RecognitionError("TABLE_NOT_FOUND", str(exc)) from exc

        warped, _, inverse = self.board_detector.warp(image, table.quad)
        if debug_dir is not None:
            cv2.imwrite(str(debug_dir / "04_board_warped.png"), warped)

        hand_crops = self.hand_extractor.extract(image, debug_dir=debug_dir)
        river_crops = self.river_extractor.extract(warped, debug_dir=debug_dir)
        hand, rejected_count = self._classify_tiles(hand_crops)

        image_height, image_width = image.shape[:2]
        rivers: Dict[str, List[TilePrediction]] = {}
        for position in ("self", "right", "opposite", "left"):
            crops = river_crops.get(position, [])
            predictions = self.classifier.predict([crop.image for crop in crops])
            river_predictions: List[TilePrediction] = []
            for crop, prediction in zip(crops, predictions):
                if prediction.code is None:
                    rejected_count += 1
                    continue
                original_box = self.board_detector.project_box_to_original(
                    crop.bbox,
                    inverse,
                    image_width,
                    image_height,
                )
                river_predictions.append(
                    TilePrediction(
                        code=prediction.code,
                        confidence=prediction.confidence,
                        bbox=BoundingBox.from_sequence(original_box),
                        model_code=prediction.model_code,
                        model_confidence=prediction.model_confidence,
                        decision_source=prediction.decision_source,
                        circle_count=prediction.circle_count,
                        structure_confidence=prediction.structure_confidence,
                        structure_votes=prediction.structure_votes,
                    )
                )
            rivers[position] = river_predictions

        warnings = self._build_warnings(hand, rivers, rejected_count)
        return RecognitionResult(
            image=ImageInfo(width=image_width, height=image_height),
            table=TableInfo(
                method=table.method,
                quad=table.quad.tolist(),
                warped_size=self.board_detector.WARP_SIZE,
            ),
            hand=hand,
            rivers=rivers,
            warnings=warnings,
        )

    def _classify_tiles(
        self,
        crops: List[ExtractedTile],
    ) -> Tuple[List[TilePrediction], int]:
        predictions = self.classifier.predict([crop.image for crop in crops])
        accepted: List[TilePrediction] = []
        rejected_count = 0
        for crop, prediction in zip(crops, predictions):
            if prediction.code is None:
                rejected_count += 1
                continue
            accepted.append(
                TilePrediction(
                    code=prediction.code,
                    confidence=prediction.confidence,
                    bbox=BoundingBox.from_sequence(crop.bbox),
                    status=crop.status,
                    model_code=prediction.model_code,
                    model_confidence=prediction.model_confidence,
                    decision_source=prediction.decision_source,
                    circle_count=prediction.circle_count,
                    structure_confidence=prediction.structure_confidence,
                    structure_votes=prediction.structure_votes,
                )
            )
        return accepted, rejected_count

    def _build_warnings(
        self,
        hand: List[TilePrediction],
        rivers: Dict[str, List[TilePrediction]],
        rejected_count: int,
    ) -> List[str]:
        warnings: List[str] = []
        if not hand:
            warnings.append("未识别到自家手牌")
        elif len(hand) > 14:
            warnings.append(f"识别到 {len(hand)} 张手牌，超过正常上限")
        elif len(hand) % 3 not in (1, 2):
            warnings.append(f"识别到 {len(hand)} 张手牌，张数不符合常见对局状态")

        all_tiles = list(hand)
        for tiles in rivers.values():
            all_tiles.extend(tiles)
        low_confidence = [
            tile for tile in all_tiles if tile.confidence < self.minimum_confidence
        ]
        if low_confidence:
            warnings.append(
                f"有 {len(low_confidence)} 张牌的识别置信度低于 "
                f"{self.minimum_confidence:.0%}，建议人工校对"
            )

        if rejected_count:
            warnings.append(
                f"分类器将 {rejected_count} 个候选切片判断为非麻将牌，已自动忽略"
            )

        structure_corrections = [
            tile
            for tile in all_tiles
            if tile.decision_source == "pin-circle-count"
        ]
        if structure_corrections:
            warnings.append(
                f"筒子圆形结构校验修正了 {len(structure_corrections)} 张模型分类，"
                "建议在校对界面确认"
            )

        visible_counts = Counter(self._canonical_code(tile.code) for tile in all_tiles)
        impossible = sorted(code for code, count in visible_counts.items() if count > 4)
        if impossible:
            warnings.append(
                "以下牌的可见数量超过四张，识别结果可能有误：" + "、".join(impossible)
            )

        if not any(rivers.values()):
            warnings.append("未识别到任何牌河牌；空牌河时可忽略此提示")
        return warnings

    @staticmethod
    def _canonical_code(code: str) -> str:
        if len(code) == 2 and code[0] == "0" and code[1] in "mps":
            return f"5{code[1]}"
        return code

    @staticmethod
    def _load_image(image_path: Path) -> np.ndarray:
        path = Path(image_path)
        if not path.is_file():
            raise RecognitionError("IMAGE_NOT_FOUND", f"截图文件不存在：{path}")
        try:
            with Image.open(path) as source:
                rgb = ImageOps.exif_transpose(source).convert("RGB")
                image = cv2.cvtColor(np.asarray(rgb), cv2.COLOR_RGB2BGR)
        except (UnidentifiedImageError, OSError) as exc:
            raise RecognitionError("INVALID_IMAGE", f"无法读取截图：{path}") from exc
        return image
