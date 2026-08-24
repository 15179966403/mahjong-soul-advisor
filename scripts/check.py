"""Run repository tests and syntax checks with one command."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Sequence


ROOT = Path(__file__).resolve().parents[1]
VENV_PYTHON = ROOT / ".venv" / "bin" / "python"
JAVASCRIPT_FILES = (
    ROOT / "src" / "mahjong.js",
    ROOT / "src" / "recognition.js",
    ROOT / "src" / "app.js",
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
    if not VENV_PYTHON.is_file():
        print("缺少 .venv，请先按照 README 安装 Python 依赖。", file=sys.stderr)
        return 2

    run(("node", "--test"))
    run((
        str(VENV_PYTHON),
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
