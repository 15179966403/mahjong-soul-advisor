"""Collect hand-tile crops from one screenshot for later labeling or training."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import List, Optional

import cv2
import numpy as np
from PIL import Image, ImageOps

from backend.recognition.preprocessing import TileFaceNormalizer
from backend.recognition.tile_extractor import HandTileExtractor


def load_image(path: Path) -> np.ndarray:
    with Image.open(path) as source:
        rgb = np.asarray(ImageOps.exif_transpose(source).convert("RGB"))
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


def parse_labels(value: Optional[str]) -> Optional[List[str]]:
    if value is None:
        return None
    labels = [label.strip() for label in value.split(",") if label.strip()]
    return labels or None


def main() -> int:
    parser = argparse.ArgumentParser(description="从截图收集真实雀魂手牌切片")
    parser.add_argument("image", type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path("datasets/private/tiles"))
    parser.add_argument(
        "--labels",
        help="按从左到右顺序提供逗号分隔标签，例如 3p,4p,6p,7p,7p",
    )
    args = parser.parse_args()

    image = load_image(args.image)
    tiles = HandTileExtractor().extract(image)
    labels = parse_labels(args.labels)
    if labels is not None and len(labels) != len(tiles):
        raise ValueError(f"提供了 {len(labels)} 个标签，但切出了 {len(tiles)} 张牌")

    normalizer = TileFaceNormalizer()
    manifest = []
    for index, tile in enumerate(tiles):
        label = labels[index] if labels is not None else "unlabeled"
        target_dir = args.output_dir / label
        target_dir.mkdir(parents=True, exist_ok=True)
        filename = f"{args.image.stem}_{index:02d}.png"
        target = target_dir / filename
        cv2.imwrite(str(target), tile.image)
        face = normalizer.crop_face(tile.image)
        manifest.append(
            {
                "file": str(target),
                "source": str(args.image),
                "index": index,
                "label": None if label == "unlabeled" else label,
                "bbox": list(tile.bbox),
                "status": tile.status,
                "removedTop": face.removed_top,
            }
        )

    manifest_dir = args.output_dir / "manifests"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    (manifest_dir / f"{args.image.stem}.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"已保存 {len(tiles)} 张切片到 {args.output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
