"""Command-line entry point for offline screenshot recognition.

Run from the repository root:

    python -m backend.recognize path/to/screenshot.png
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Optional, Sequence

from backend.recognition import RecognitionError, RecognitionService


BACKEND_DIR = Path(__file__).resolve().parent
DEFAULT_MODEL_PATH = BACKEND_DIR / "models" / "best_model.pt"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="识别雀魂截图中的自家手牌和四家牌河",
    )
    parser.add_argument("image", type=Path, help="完整的雀魂横屏对局截图")
    parser.add_argument(
        "--model",
        type=Path,
        default=DEFAULT_MODEL_PATH,
        help=f"TileNet 模型路径，默认：{DEFAULT_MODEL_PATH}",
    )
    parser.add_argument(
        "--device",
        choices=("auto", "cpu", "mps", "cuda"),
        default="auto",
        help="推理设备，默认自动选择",
    )
    parser.add_argument(
        "--minimum-confidence",
        type=float,
        default=0.65,
        help="低置信度告警阈值，默认 0.65",
    )
    parser.add_argument(
        "--debug-dir",
        type=Path,
        help="保存牌桌定位、切割框和牌面切片的目录",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="JSON 输出文件；省略时写到标准输出",
    )
    parser.add_argument(
        "--compact",
        action="store_true",
        help="输出紧凑 JSON",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        service = RecognitionService(
            model_path=args.model,
            device=args.device,
            minimum_confidence=args.minimum_confidence,
        )
        result = service.recognize_path(args.image, debug_dir=args.debug_dir)
        payload = result.to_dict()
    except RecognitionError as exc:
        error_payload = {
            "error": {
                "code": exc.code,
                "message": exc.message,
            }
        }
        print(json.dumps(error_payload, ensure_ascii=False, indent=2), file=sys.stderr)
        return 2
    except (ValueError, RuntimeError) as exc:
        error_payload = {
            "error": {
                "code": "RECOGNITION_FAILED",
                "message": str(exc),
            }
        }
        print(json.dumps(error_payload, ensure_ascii=False, indent=2), file=sys.stderr)
        return 2

    rendered = json.dumps(
        payload,
        ensure_ascii=False,
        indent=None if args.compact else 2,
    )
    if args.output is None:
        print(rendered)
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
