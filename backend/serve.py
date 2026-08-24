"""Command-line launcher for the localhost-only recognition API."""

from __future__ import annotations

import argparse
from dataclasses import replace
from pathlib import Path
from typing import Optional, Sequence

import uvicorn

from backend.app import create_app
from backend.config import ApiSettings


def build_parser(settings: ApiSettings) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="启动本地雀魂截图识别 API")
    parser.add_argument("--host", default=settings.host, help="仅允许本机回环地址")
    parser.add_argument("--port", type=int, default=settings.port)
    parser.add_argument("--model", type=Path, default=settings.model_path)
    parser.add_argument(
        "--device",
        choices=("auto", "cpu", "mps", "cuda"),
        default=settings.device,
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=settings.recognition_timeout_seconds,
        help="单次识别超时秒数",
    )
    parser.add_argument(
        "--log-level",
        choices=("critical", "error", "warning", "info", "debug"),
        default="info",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    environment = ApiSettings.from_environment()
    args = build_parser(environment).parse_args(argv)
    settings = replace(
        environment,
        host=args.host,
        port=args.port,
        model_path=args.model,
        device=args.device,
        recognition_timeout_seconds=args.timeout,
    ).validate()
    uvicorn.run(
        create_app(settings),
        host=settings.host,
        port=settings.port,
        log_level=args.log_level,
        access_log=False,
        server_header=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
