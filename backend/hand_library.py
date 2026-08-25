"""Build, inspect and evaluate the private upright-hand template library."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import List, Optional, Sequence

import cv2

from backend.collect_tiles import load_image, parse_labels
from backend.recognition.hand_templates import (
    HAND_TILE_CODES,
    HandTemplateMatcher,
    validate_hand_labels,
)
from backend.recognition.tile_extractor import HandTileExtractor


DEFAULT_LIBRARY_DIR = Path("datasets/private/hand_templates")


def collect_screenshot(
    image_path: Path,
    labels: Sequence[str],
    library_dir: Path,
) -> List[dict]:
    validate_hand_labels(labels)
    image = load_image(image_path)
    tiles = HandTileExtractor().extract(image)
    if len(labels) != len(tiles):
        raise ValueError(
            f"提供了 {len(labels)} 个标签，但切出了 {len(tiles)} 张牌"
        )

    targets = [
        library_dir / label / f"{image_path.stem}_{index:02d}.png"
        for index, label in enumerate(labels)
    ]
    existing = [target for target in targets if target.exists()]
    if existing:
        raise FileExistsError("模板已存在：" + "、".join(str(path) for path in existing))

    manifest: List[dict] = []
    for index, (tile, label) in enumerate(zip(tiles, labels)):
        target_dir = library_dir / label
        target_dir.mkdir(parents=True, exist_ok=True)
        target = targets[index]
        if not cv2.imwrite(str(target), tile.image):
            raise OSError(f"无法保存模板：{target}")
        manifest.append(
            {
                "file": str(target),
                "source": str(image_path),
                "index": index,
                "label": label,
                "bbox": list(tile.bbox),
                "status": tile.status,
            }
        )

    manifest_dir = library_dir / "manifests"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = manifest_dir / f"{image_path.stem}.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest


def evaluate_library(matcher: HandTemplateMatcher) -> dict:
    coverage = matcher.coverage()
    correct = 0
    evaluated = 0
    rejected = 0
    skipped: Counter[str] = Counter()
    errors = []
    sources_by_code = {
        code: {sample.source for sample in matcher.samples if sample.code == code}
        for code in HAND_TILE_CODES
    }
    for sample in matcher.samples:
        if not (sources_by_code[sample.code] - {sample.source}):
            skipped[sample.code] += 1
            continue
        image = cv2.imread(str(sample.path), cv2.IMREAD_COLOR)
        prediction = matcher.predict(image, exclude_source=sample.source)
        evaluated += 1
        if prediction.code == sample.code:
            correct += 1
            continue
        if prediction.code is None:
            rejected += 1
        errors.append(
            {
                "sample": str(sample.path),
                "expected": sample.code,
                "predicted": prediction.to_dict(),
            }
        )
    return {
        "samples": len(matcher.samples),
        "classes": len(coverage),
        "coverage": dict(sorted(coverage.items())),
        "missingCodes": matcher.missing_codes(),
        "evaluated": evaluated,
        "correct": correct,
        "rejected": rejected,
        "accuracy": round(correct / evaluated, 6) if evaluated else 0.0,
        "skippedWithoutAnotherSource": dict(sorted(skipped.items())),
        "errors": errors,
    }


def match_screenshot(
    image_path: Path,
    matcher: HandTemplateMatcher,
    exclude_source: Optional[str] = None,
) -> dict:
    tiles = HandTileExtractor().extract(load_image(image_path))
    predictions = []
    for index, tile in enumerate(tiles):
        prediction = matcher.predict(tile.image, exclude_source=exclude_source)
        predictions.append(
            {
                "index": index,
                "bbox": list(tile.bbox),
                "status": tile.status,
                **prediction.to_dict(),
            }
        )
    return {
        "source": str(image_path),
        "excludedTemplateSource": exclude_source,
        "hand": predictions,
        "codes": [prediction["code"] for prediction in predictions],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="正面手牌模板库实验工具")
    parser.add_argument(
        "--library-dir",
        type=Path,
        default=DEFAULT_LIBRARY_DIR,
        help=f"模板库目录，默认 {DEFAULT_LIBRARY_DIR}",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    collect_parser = subparsers.add_parser("collect", help="收集一张人工确认的手牌")
    collect_parser.add_argument("image", type=Path)
    collect_parser.add_argument(
        "--labels",
        required=True,
        help="从左到右的逗号分隔标签；必须经过人工确认",
    )

    subparsers.add_parser("coverage", help="查看模板类别覆盖情况")
    subparsers.add_parser("evaluate", help="按来源截图执行留出评估")
    match_parser = subparsers.add_parser("match", help="使用模板库识别一张截图的手牌")
    match_parser.add_argument("image", type=Path)
    match_parser.add_argument(
        "--leave-source-out",
        action="store_true",
        help="排除与输入文件同名来源的模板，用于公平复测已入库截图",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "collect":
        labels = parse_labels(args.labels)
        if not labels:
            raise ValueError("必须提供至少一个手牌标签")
        manifest = collect_screenshot(args.image, labels, args.library_dir)
        print(
            json.dumps(
                {"saved": len(manifest), "libraryDir": str(args.library_dir)},
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    matcher = HandTemplateMatcher(args.library_dir)
    if args.command == "coverage":
        payload = {
            "samples": len(matcher.samples),
            "classes": len(matcher.coverage()),
            "coverage": dict(sorted(matcher.coverage().items())),
            "missingCodes": matcher.missing_codes(),
        }
    elif args.command == "evaluate":
        payload = evaluate_library(matcher)
    else:
        excluded_source = args.image.stem if args.leave_source_out else None
        payload = match_screenshot(args.image, matcher, excluded_source)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
