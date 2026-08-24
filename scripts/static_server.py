"""Serve the local frontend on loopback without browser caching."""

from __future__ import annotations

import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional, Sequence


class NoCacheRequestHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *args) -> None:
        del args

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="启动本地网页服务")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4173)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    if args.host not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("静态网页服务只允许绑定本机回环地址")
    with ThreadingHTTPServer((args.host, args.port), NoCacheRequestHandler) as server:
        print(f"网页服务：http://{args.host}:{args.port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
