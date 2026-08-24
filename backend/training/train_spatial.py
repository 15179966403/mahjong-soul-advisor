"""Train SpatialTileNet with face normalization and per-class metrics.

Dataset layout::

    datasets/private/tiles/
        1m/*.png
        1p/*.png
        ...
        5p-/*.png
        x/*.png
"""

from __future__ import annotations

import argparse
import json
import math
import random
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np
import torch
from PIL import Image
from torch import nn
from torch.utils.data import DataLoader, Dataset
from torchvision import transforms
from tqdm import tqdm

from backend.recognition.model import SpatialTileNet
from backend.recognition.preprocessing import TileFaceNormalizer


Sample = Tuple[Path, str]
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}


class NormalizeTileFace:
    def __init__(self, size: int = 64) -> None:
        self.size = size
        self.normalizer = TileFaceNormalizer()

    def __call__(self, image: Image.Image) -> Image.Image:
        rgb = np.asarray(image.convert("RGB"))
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        face = self.normalizer.crop_face(bgr).image
        boxed = self.normalizer.letterbox(face, size=self.size)
        return Image.fromarray(cv2.cvtColor(boxed, cv2.COLOR_BGR2RGB))


class TileDataset(Dataset):
    def __init__(
        self,
        samples: Sequence[Sample],
        class_to_index: Dict[str, int],
        transform,
    ) -> None:
        self.samples = list(samples)
        self.class_to_index = class_to_index
        self.transform = transform

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, index: int):
        path, label = self.samples[index]
        with Image.open(path) as source:
            image = source.convert("RGB")
        return self.transform(image), self.class_to_index[label]


def collect_samples(root: Path) -> List[Sample]:
    samples: List[Sample] = []
    ignored_directories = {"unlabeled", "manifests"}
    for class_dir in sorted(
        path
        for path in root.iterdir()
        if path.is_dir() and path.name not in ignored_directories
    ):
        for path in sorted(class_dir.iterdir()):
            if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS:
                samples.append((path, class_dir.name))
    if not samples:
        raise ValueError(f"Dataset contains no images: {root}")
    return samples


def stratified_split(
    samples: Sequence[Sample],
    validation_ratio: float,
    seed: int,
) -> Tuple[List[Sample], List[Sample]]:
    grouped: Dict[str, List[Sample]] = defaultdict(list)
    for sample in samples:
        grouped[sample[1]].append(sample)

    generator = random.Random(seed)
    train: List[Sample] = []
    validation: List[Sample] = []
    for label, group in grouped.items():
        generator.shuffle(group)
        validation_count = 0
        if len(group) > 1:
            validation_count = max(1, int(round(len(group) * validation_ratio)))
            validation_count = min(validation_count, len(group) - 1)
        validation.extend(group[:validation_count])
        train.extend(group[validation_count:])
    generator.shuffle(train)
    generator.shuffle(validation)
    return train, validation


def load_classes(samples: Sequence[Sample], initialize_from: Optional[Path]) -> List[str]:
    dataset_classes = sorted({label for _, label in samples})
    if initialize_from is None:
        return dataset_classes
    checkpoint = torch.load(initialize_from, map_location="cpu", weights_only=False)
    checkpoint_classes = [str(label) for label in checkpoint.get("classes", [])]
    if not checkpoint_classes:
        raise ValueError("Initialization checkpoint has no classes list")
    unknown = sorted(set(dataset_classes) - set(checkpoint_classes))
    if unknown:
        raise ValueError(f"Dataset contains classes absent from checkpoint: {unknown}")
    return checkpoint_classes


def initialize_features(model: SpatialTileNet, checkpoint_path: Path) -> None:
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    source = checkpoint.get("model_state") or checkpoint.get("state_dict")
    if source is None:
        raise ValueError("Initialization checkpoint has no model weights")
    target = model.state_dict()
    compatible = {
        key: value
        for key, value in source.items()
        if key.startswith("features.") and key in target and target[key].shape == value.shape
    }
    model.load_state_dict(compatible, strict=False)


def build_class_weights(samples: Sequence[Sample], classes: Sequence[str]) -> torch.Tensor:
    counts = Counter(label for _, label in samples)
    weights = [1.0 / math.sqrt(max(1, counts.get(label, 0))) for label in classes]
    mean = sum(weights) / len(weights)
    return torch.tensor([weight / mean for weight in weights], dtype=torch.float32)


def run_epoch(model, loader, loss_function, device, optimizer=None):
    training = optimizer is not None
    model.train(training)
    total_loss = 0.0
    total_correct = 0
    total_items = 0
    predictions: List[int] = []
    targets: List[int] = []
    context = torch.enable_grad() if training else torch.inference_mode()
    with context:
        for images, labels in tqdm(loader, leave=False):
            images, labels = images.to(device), labels.to(device)
            if training:
                optimizer.zero_grad()
            logits = model(images)
            loss = loss_function(logits, labels)
            if training:
                loss.backward()
                optimizer.step()
            batch_predictions = logits.argmax(dim=1)
            total_loss += float(loss.item()) * len(labels)
            total_correct += int((batch_predictions == labels).sum().item())
            total_items += len(labels)
            predictions.extend(batch_predictions.cpu().tolist())
            targets.extend(labels.cpu().tolist())
    return {
        "loss": total_loss / max(1, total_items),
        "accuracy": total_correct / max(1, total_items),
        "predictions": predictions,
        "targets": targets,
    }


def per_class_metrics(result: dict, classes: Sequence[str]) -> dict:
    totals = Counter(result["targets"])
    correct = Counter(
        target
        for target, prediction in zip(result["targets"], result["predictions"])
        if target == prediction
    )
    confusion = Counter(zip(result["targets"], result["predictions"]))
    return {
        "accuracy": {
            classes[index]: correct[index] / totals[index] if totals[index] else None
            for index in range(len(classes))
        },
        "confusion": {
            f"{classes[target]}->{classes[prediction]}": count
            for (target, prediction), count in confusion.items()
            if target != prediction
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="训练保留空间布局的 TileNet v2")
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, default=Path("backend/models/v2"))
    parser.add_argument("--initialize-from", type=Path, default=Path("backend/models/best_model.pt"))
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--validation-ratio", type=float, default=0.2)
    parser.add_argument("--seed", type=int, default=20260823)
    args = parser.parse_args()

    torch.manual_seed(args.seed)
    samples = collect_samples(args.data_dir)
    classes = load_classes(samples, args.initialize_from)
    class_to_index = {label: index for index, label in enumerate(classes)}
    train_samples, validation_samples = stratified_split(
        samples,
        args.validation_ratio,
        args.seed,
    )
    if not validation_samples:
        raise ValueError("Validation set is empty; provide at least two samples for a class")

    normalize = NormalizeTileFace(64)
    train_transform = transforms.Compose(
        [
            normalize,
            transforms.RandomRotation(4, fill=(245, 245, 245)),
            transforms.ColorJitter(brightness=0.12, contrast=0.12, saturation=0.08),
            transforms.ToTensor(),
            transforms.Normalize(mean=[0.5] * 3, std=[0.5] * 3),
        ]
    )
    validation_transform = transforms.Compose(
        [
            normalize,
            transforms.ToTensor(),
            transforms.Normalize(mean=[0.5] * 3, std=[0.5] * 3),
        ]
    )
    train_dataset = TileDataset(train_samples, class_to_index, train_transform)
    validation_dataset = TileDataset(validation_samples, class_to_index, validation_transform)
    train_loader = DataLoader(train_dataset, batch_size=args.batch_size, shuffle=True)
    validation_loader = DataLoader(validation_dataset, batch_size=args.batch_size, shuffle=False)

    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    model = SpatialTileNet(len(classes))
    if args.initialize_from is not None:
        initialize_features(model, args.initialize_from)
    model.to(device)
    loss_function = nn.CrossEntropyLoss(
        weight=build_class_weights(train_samples, classes).to(device)
    )
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate)

    args.output_dir.mkdir(parents=True, exist_ok=True)
    history = []
    best_accuracy = -1.0
    for epoch in range(1, args.epochs + 1):
        train_result = run_epoch(model, train_loader, loss_function, device, optimizer)
        validation_result = run_epoch(model, validation_loader, loss_function, device)
        metrics = per_class_metrics(validation_result, classes)
        record = {
            "epoch": epoch,
            "trainLoss": train_result["loss"],
            "trainAccuracy": train_result["accuracy"],
            "validationLoss": validation_result["loss"],
            "validationAccuracy": validation_result["accuracy"],
            "perClass": metrics,
        }
        history.append(record)
        print(json.dumps(record, ensure_ascii=False))
        if validation_result["accuracy"] > best_accuracy:
            best_accuracy = validation_result["accuracy"]
            torch.save(
                {
                    "architecture": "spatial_tilenet_v2",
                    "preprocessing": "face-letterbox-v1",
                    "model_state": model.state_dict(),
                    "classes": classes,
                    "validation_metrics": metrics,
                },
                args.output_dir / "best_model.pt",
            )

    (args.output_dir / "training_history.json").write_text(
        json.dumps(history, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
