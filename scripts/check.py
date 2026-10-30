"""Run repository tests and syntax checks with one command."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Optional, Sequence


ROOT = Path(__file__).resolve().parents[1]


def find_venv_python() -> Optional[Path]:
    for candidate in (
        ROOT / ".venv" / "Scripts" / "python.exe",
        ROOT / ".venv" / "bin" / "python",
    ):
        if candidate.is_file():
            return candidate
    return None


JAVASCRIPT_FILES = (
    ROOT / "src" / "mahjong.js",
    ROOT / "src" / "recognition.js",
    ROOT / "src" / "app.js",
    ROOT / "src" / "paipu" / "tile_converter.js",
    ROOT / "src" / "paipu" / "tenhou_parser.js",
    ROOT / "src" / "paipu" / "mjai_parser.js",
    ROOT / "src" / "paipu" / "game_replayer.js",
    ROOT / "src" / "paipu" / "majsoul_parser.js",
    ROOT / "src" / "paipu" / "paipu_service.js",
    ROOT / "src" / "paipu" / "paipu_ui.js",
)


def run(command: Sequence[str]) -> None:
    print("+", " ".join(command), flush=True)
    subprocess.run(command, cwd=ROOT, check=True)


def compile_python_sources() -> None:
    sources = sorted((ROOT / "backend").rglob("*.py"))
    sources.extend(sorted((ROOT / "scripts").glob("*.py")))
    for source in sources:
        compile(source.read_text(encoding="utf-8"), str(source), "exec")
    print(f"Python syntax: {len(sources)} files", flush=True)


def main() -> int:
    venv_python = find_venv_python()
    if venv_python is None:
        print("缺少 .venv，请先按照 README 安装 Python 依赖。", file=sys.stderr)
        return 2

    run(("node", "--test"))
    run((
        str(venv_python),
        "-m",
        "unittest",
        "discover",
        "-s",
        "backend/tests",
        "-t",
        ".",
    ))
    for source in JAVASCRIPT_FILES:
        run(("node", "--check", str(source.relative_to(ROOT))))
    compile_python_sources()
    print("全部检查通过。", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
