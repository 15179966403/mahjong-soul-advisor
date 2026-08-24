"""Batch inference for Mahjong tile crops."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

import cv2
import numpy as np
import torch

from .model import SpatialTileNet, TileNet
from .pin_structure import PinCircleCounter
from .preprocessing import TileFaceNormalizer


class ModelLoadError(RuntimeError):
    """Raised when a classifier checkpoint cannot be loaded safely."""


@dataclass(frozen=True)
class ClassPrediction:
    code: Optional[str]
    confidence: float
    raw_label: str
    model_code: Optional[str]
    model_confidence: float
    decision_source: str = "model"
    circle_count: Optional[int] = None
    structure_confidence: Optional[float] = None
    structure_votes: Tuple[int, ...] = ()


RED_FIVE_LABELS = {
    "5m-": "0m",
    "5p-": "0p",
    "5s-": "0s",
    "red5m": "0m",
    "red5p": "0p",
    "red5s": "0s",
}

NON_TILE_LABELS = {"x", "bg", "background", "unknown"}

CENTER_CROP_TRIGGER_CONFIDENCE = 0.35
CENTER_CROP_RATIOS = (0.04, 0.08, 0.12)
CENTER_CROP_MIN_CONFIDENCE = 0.30
CENTER_CROP_MIN_GAIN = 0.08

VERTICAL_CROP_TRIGGER_CONFIDENCE = 0.35
VERTICAL_CROP_VARIANTS = (("top", 0.08), ("bottom", 0.08), ("bottom", 0.15))
VERTICAL_CROP_MIN_CONFIDENCE = 0.30
VERTICAL_CROP_MIN_GAIN = 0.08


def normalize_tile_code(label: str) -> Optional[str]:
    """Convert checkpoint labels to advisor notation.

    The bundled checkpoint contains an additional ``x`` class for crops that
    are not Mahjong tiles. ``None`` keeps that class in the neural-network
    output while allowing the recognition service to discard the candidate.
    """

    normalized = str(label).strip().lower()
    if normalized in NON_TILE_LABELS:
        return None
    if normalized in RED_FIVE_LABELS:
        return RED_FIVE_LABELS[normalized]

    if len(normalized) == 2 and normalized[0] in "mpsz" and normalized[1].isdigit():
        normalized = f"{normalized[1]}{normalized[0]}"

    if len(normalized) != 2 or not normalized[0].isdigit():
        raise ModelLoadError(f"Unsupported tile label in checkpoint: {label!r}")

    rank = int(normalized[0])
    suit = normalized[1]
    if suit in "mps" and 0 <= rank <= 9:
        return normalized
    if suit == "z" and 1 <= rank <= 7:
        return normalized
    raise ModelLoadError(f"Unsupported tile label in checkpoint: {label!r}")


def resolve_device(requested: str) -> torch.device:
    if requested != "auto":
        return torch.device(requested)
    if torch.cuda.is_available():
        return torch.device("cuda")
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


class TileClassifier:
    """Load the trusted bundled TileNet checkpoint and classify tile crops."""

    def __init__(self, model_path: Path, device: str = "auto") -> None:
        self.model_path = Path(model_path)
        if not self.model_path.is_file():
            raise ModelLoadError(f"Model file does not exist: {self.model_path}")

        self.device = resolve_device(device)
        self.normalizer = TileFaceNormalizer()
        self.pin_counter = PinCircleCounter(self.normalizer)
        try:
            checkpoint = torch.load(
                self.model_path,
                map_location=self.device,
                weights_only=False,
            )
        except Exception as exc:
            raise ModelLoadError(f"Unable to load model: {self.model_path}") from exc

        if not isinstance(checkpoint, dict):
            raise ModelLoadError("Checkpoint must be a mapping")

        raw_classes = checkpoint.get("classes")
        if not isinstance(raw_classes, (list, tuple)) or not raw_classes:
            raise ModelLoadError("Checkpoint does not contain a non-empty classes list")

        state_dict = checkpoint.get("model_state") or checkpoint.get("state_dict")
        if state_dict is None:
            raise ModelLoadError("Checkpoint does not contain model_state or state_dict")

        self.raw_classes = [str(label) for label in raw_classes]
        self.classes = [normalize_tile_code(label) for label in self.raw_classes]
        self.architecture = str(checkpoint.get("architecture", "tilenet_v1"))
        self.preprocessing = str(
            checkpoint.get(
                "preprocessing",
                "face-crop-stretch-v1" if self.architecture == "tilenet_v1" else "face-letterbox-v1",
            )
        )
        if self.architecture == "tilenet_v1":
            self.model = TileNet(num_classes=len(self.classes))
        elif self.architecture == "spatial_tilenet_v2":
            self.model = SpatialTileNet(num_classes=len(self.classes))
        else:
            raise ModelLoadError(f"Unsupported model architecture: {self.architecture}")
        try:
            self.model.load_state_dict(state_dict)
        except Exception as exc:
            raise ModelLoadError("Checkpoint weights do not match TileNet") from exc
        self.model.to(self.device)
        self.model.eval()

    def predict(self, images: Sequence[np.ndarray]) -> List[ClassPrediction]:
        if not images:
            return []

        tensors = [self._prepare_image(image) for image in images]
        inputs = torch.stack(tensors).to(self.device)
        with torch.inference_mode():
            logits = self.model(inputs)
            probabilities = torch.softmax(logits, dim=1)
            confidence, indices = probabilities.max(dim=1)

        crop_consensus = self._center_crop_consensus(
            images,
            indices.tolist(),
            confidence.tolist(),
        )
        vertical_consensus = self._vertical_crop_consensus(
            images,
            indices.tolist(),
            confidence.tolist(),
            excluded_positions=set(crop_consensus),
        )

        results: List[ClassPrediction] = []
        for position, (image, index, score) in enumerate(
            zip(images, indices.tolist(), confidence.tolist())
        ):
            model_code = self.classes[index]
            final_code = model_code
            final_confidence = float(score)
            decision_source = "model"
            circle_count = None
            structure_confidence = None
            structure_votes: Tuple[int, ...] = ()

            consensus = crop_consensus.get(position)
            if consensus is not None:
                consensus_index, consensus_confidence = consensus
                final_code = self.classes[consensus_index]
                final_confidence = consensus_confidence
                decision_source = "center-crop-consensus"

            consensus = vertical_consensus.get(position)
            if consensus is not None:
                consensus_index, consensus_confidence = consensus
                final_code = self.classes[consensus_index]
                final_confidence = consensus_confidence
                decision_source = "vertical-crop-consensus"

            # The 1p artwork contains several nested decorative rings. The
            # generic small-pip Hough counter sees those rings as separate
            # circles, so a confident 1p model decision must not be replaced
            # by the 2p-9p structural helper.
            if (
                final_code is not None
                and final_code.endswith("p")
                and final_code != "1p"
            ):
                structure = self.pin_counter.predict(image)
                if structure is not None:
                    circle_count = structure.circle_count
                    structure_confidence = structure.confidence
                    structure_votes = structure.votes
                    structure_code = f"{structure.circle_count}p"
                    if final_code == "0p" and structure.circle_count == 5:
                        structure_code = "0p"
                    if structure_code != final_code:
                        final_code = structure_code
                        final_confidence = structure.confidence
                        decision_source = "pin-circle-count"
                    else:
                        final_confidence = max(final_confidence, structure.confidence)
                        decision_source = f"{decision_source}+pin-circle-count"

            results.append(
                ClassPrediction(
                    code=final_code,
                    confidence=final_confidence,
                    raw_label=self.raw_classes[index],
                    model_code=model_code,
                    model_confidence=float(score),
                    decision_source=decision_source,
                    circle_count=circle_count,
                    structure_confidence=structure_confidence,
                    structure_votes=structure_votes,
                )
            )
        return results

    def _center_crop_consensus(
        self,
        images: Sequence[np.ndarray],
        original_indices: Sequence[int],
        original_confidences: Sequence[float],
    ) -> dict[int, Tuple[int, float]]:
        """Retry very uncertain crops after removing narrow side borders.

        River tiles have small perspective and segmentation differences between
        seats. Stretching a slightly wider crop to 64x64 can change the shape of
        dense characters such as 4m. A correction is accepted only when all
        three centered crops agree, beat the original result by a meaningful
        margin and still remain visible as low confidence to the review UI.
        """

        uncertain_positions = [
            position
            for position, (index, score) in enumerate(
                zip(original_indices, original_confidences)
            )
            if score < CENTER_CROP_TRIGGER_CONFIDENCE
            and self.classes[index] is not None
        ]
        if not uncertain_positions:
            return {}

        variant_tensors: List[torch.Tensor] = []
        for position in uncertain_positions:
            image = images[position]
            height, width = image.shape[:2]
            for ratio in CENTER_CROP_RATIOS:
                removed_width = max(1, int(round(width * ratio)))
                if width - removed_width * 2 < 4:
                    variant = image
                else:
                    variant = image[:height, removed_width:width - removed_width]
                variant_tensors.append(self._prepare_image(variant))

        inputs = torch.stack(variant_tensors).to(self.device)
        with torch.inference_mode():
            probabilities = torch.softmax(self.model(inputs), dim=1)

        corrections: dict[int, Tuple[int, float]] = {}
        variants_per_image = len(CENTER_CROP_RATIOS)
        for group_index, position in enumerate(uncertain_positions):
            start = group_index * variants_per_image
            group = probabilities[start:start + variants_per_image]
            votes = group.argmax(dim=1).tolist()
            if len(set(votes)) != 1:
                continue

            consensus_index = int(votes[0])
            consensus_code = self.classes[consensus_index]
            if consensus_code is None or consensus_index == original_indices[position]:
                continue

            consensus_confidence = float(group[:, consensus_index].mean().item())
            original_confidence = float(original_confidences[position])
            if (
                consensus_confidence >= CENTER_CROP_MIN_CONFIDENCE
                and consensus_confidence >= original_confidence + CENTER_CROP_MIN_GAIN
            ):
                corrections[position] = (consensus_index, consensus_confidence)
        return corrections

    def _vertical_crop_consensus(
        self,
        images: Sequence[np.ndarray],
        original_indices: Sequence[int],
        original_confidences: Sequence[float],
        excluded_positions: set[int],
    ) -> dict[int, Tuple[int, float]]:
        """Retry uncertain manzu crops after removing narrow top/bottom borders.

        Some hand-tile crops contain a little more frame above or below the
        artwork. The legacy model stretches that frame together with the tile
        face and can confuse dense manzu characters. This fallback is kept
        deliberately narrow: it runs only for low-confidence manzu results not
        already fixed by the side-crop consensus, and all three variants must
        agree on another manzu class before a correction is accepted.
        """

        uncertain_positions = [
            position
            for position, (index, score) in enumerate(
                zip(original_indices, original_confidences)
            )
            if position not in excluded_positions
            and score < VERTICAL_CROP_TRIGGER_CONFIDENCE
            and self.classes[index] is not None
            and self.classes[index].endswith("m")
        ]
        if not uncertain_positions:
            return {}

        variant_tensors: List[torch.Tensor] = []
        for position in uncertain_positions:
            image = images[position]
            height, width = image.shape[:2]
            for edge, ratio in VERTICAL_CROP_VARIANTS:
                removed_height = max(1, int(round(height * ratio)))
                if height - removed_height < 4:
                    variant = image
                elif edge == "top":
                    variant = image[removed_height:height, :width]
                else:
                    variant = image[:height - removed_height, :width]
                variant_tensors.append(self._prepare_image(variant))

        inputs = torch.stack(variant_tensors).to(self.device)
        with torch.inference_mode():
            probabilities = torch.softmax(self.model(inputs), dim=1)

        corrections: dict[int, Tuple[int, float]] = {}
        variants_per_image = len(VERTICAL_CROP_VARIANTS)
        for group_index, position in enumerate(uncertain_positions):
            start = group_index * variants_per_image
            group = probabilities[start:start + variants_per_image]
            votes = group.argmax(dim=1).tolist()
            if len(set(votes)) != 1:
                continue

            consensus_index = int(votes[0])
            consensus_code = self.classes[consensus_index]
            if (
                consensus_code is None
                or not consensus_code.endswith("m")
                or consensus_index == original_indices[position]
            ):
                continue

            consensus_confidence = float(group[:, consensus_index].mean().item())
            original_confidence = float(original_confidences[position])
            if (
                consensus_confidence >= VERTICAL_CROP_MIN_CONFIDENCE
                and consensus_confidence >= original_confidence + VERTICAL_CROP_MIN_GAIN
            ):
                corrections[position] = (consensus_index, consensus_confidence)
        return corrections

    def _prepare_image(self, image: np.ndarray) -> torch.Tensor:
        if image is None or image.size == 0:
            raise ValueError("Cannot classify an empty tile crop")
        if image.ndim != 3 or image.shape[2] != 3:
            raise ValueError("Tile crop must be a three-channel BGR image")

        face = self.normalizer.crop_face(image).image
        if self.preprocessing == "face-letterbox-v1":
            prepared = self.normalizer.letterbox(face, size=64)
        elif self.preprocessing == "face-crop-stretch-v1":
            prepared = cv2.resize(face, (64, 64), interpolation=cv2.INTER_AREA)
        else:
            raise ModelLoadError(f"Unsupported model preprocessing: {self.preprocessing}")

        rgb = cv2.cvtColor(prepared, cv2.COLOR_BGR2RGB)
        normalized = (rgb.astype(np.float32) / 255.0 - 0.5) / 0.5
        channels_first = np.transpose(normalized, (2, 0, 1)).copy()
        return torch.from_numpy(channels_first)
