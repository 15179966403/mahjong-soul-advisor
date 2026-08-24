"""Serializable data structures shared by the recognition CLI and future API."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence


@dataclass(frozen=True)
class BoundingBox:
    x: int
    y: int
    width: int
    height: int

    @classmethod
    def from_sequence(cls, values: Sequence[int]) -> "BoundingBox":
        if len(values) != 4:
            raise ValueError("Bounding box must contain x, y, width and height")
        return cls(*(int(value) for value in values))

    def to_list(self) -> List[int]:
        return [self.x, self.y, self.width, self.height]


@dataclass(frozen=True)
class TilePrediction:
    code: str
    confidence: float
    bbox: BoundingBox
    status: Optional[str] = None
    model_code: Optional[str] = None
    model_confidence: Optional[float] = None
    decision_source: str = "model"
    circle_count: Optional[int] = None
    structure_confidence: Optional[float] = None
    structure_votes: Sequence[int] = ()
    sideways: bool = False

    def to_dict(self) -> dict:
        payload = {
            "code": self.code,
            "confidence": round(float(self.confidence), 6),
            "bbox": self.bbox.to_list(),
        }
        if self.status is not None:
            payload["status"] = self.status
        if self.sideways:
            payload["sideways"] = True
        if self.model_code is not None:
            recognition = {
                "source": self.decision_source,
                "modelCode": self.model_code,
                "modelConfidence": round(float(self.model_confidence or 0.0), 6),
            }
            if self.circle_count is not None:
                recognition["circleCount"] = self.circle_count
                recognition["structureConfidence"] = round(
                    float(self.structure_confidence or 0.0),
                    6,
                )
                recognition["structureVotes"] = [int(vote) for vote in self.structure_votes]
            payload["recognition"] = recognition
        return payload


@dataclass(frozen=True)
class RecognitionContext:
    riichi: Dict[str, bool] = field(default_factory=dict)
    dora_indicators: Sequence[TilePrediction] = ()
    self_wind: Optional[str] = None
    round_wind: Optional[str] = None
    round_wind_confidence: Optional[float] = None

    def to_dict(self) -> dict:
        payload = {
            "riichi": {
                position: bool(self.riichi.get(position, False))
                for position in ("self", "right", "opposite", "left")
            },
            "doraIndicators": [tile.to_dict() for tile in self.dora_indicators],
        }
        if self.self_wind is not None:
            payload["selfWind"] = self.self_wind
        if self.round_wind is not None:
            payload["roundWind"] = self.round_wind
            payload["roundWindConfidence"] = round(
                float(self.round_wind_confidence or 0.0),
                6,
            )
        return payload


@dataclass(frozen=True)
class ImageInfo:
    width: int
    height: int

    def to_dict(self) -> dict:
        return {"width": self.width, "height": self.height}


@dataclass(frozen=True)
class TableInfo:
    method: str
    quad: Sequence[Sequence[float]]
    warped_size: int

    def to_dict(self) -> dict:
        return {
            "method": self.method,
            "quad": [
                [round(float(point[0]), 3), round(float(point[1]), 3)]
                for point in self.quad
            ],
            "warpedSize": self.warped_size,
        }


@dataclass
class RecognitionResult:
    image: ImageInfo
    table: TableInfo
    hand: List[TilePrediction] = field(default_factory=list)
    rivers: Dict[str, List[TilePrediction]] = field(default_factory=dict)
    context: RecognitionContext = field(default_factory=RecognitionContext)
    warnings: List[str] = field(default_factory=list)
    schema_version: int = 1

    def to_dict(self) -> dict:
        return {
            "schemaVersion": self.schema_version,
            "image": self.image.to_dict(),
            "table": self.table.to_dict(),
            "hand": [tile.to_dict() for tile in self.hand],
            "rivers": {
                position: [tile.to_dict() for tile in tiles]
                for position, tiles in self.rivers.items()
            },
            "context": self.context.to_dict(),
            "warnings": list(self.warnings),
        }
