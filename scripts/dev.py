"""Launch the static frontend and localhost recognition API together."""

from __future__ import annotations

import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable, List, Sequence, Tuple


ROOT = Path(__file__).resolve().parents[1]
def find_venv_python() -> Path:
    for candidate in (
        ROOT / ".venv" / "Scripts" / "python.exe",
        ROOT / ".venv" / "bin" / "python",
    ):
        if candidate.is_file():
            return candidate
    return ROOT / ".venv" / "bin" / "python"


VENV_PYTHON = find_venv_python()
FRONTEND_URL = "http://127.0.0.1:4173/"
HEALTH_URL = "http://127.0.0.1:8765/api/health"
STARTUP_TIMEOUT_SECONDS = 60


def stop_processes(processes: List[subprocess.Popen]) -> None:
    for process in processes:
        if process.poll() is None:
            process.terminate()
    deadline = time.monotonic() + 3
    for process in processes:
        if process.poll() is not None:
            continue
        try:
            process.wait(timeout=max(0.1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            process.kill()
    for process in processes:
        if process.poll() is None:
            process.wait()


def url_is_ready(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=0.8) as response:
            return 200 <= response.status < 300
    except (OSError, urllib.error.URLError):
        return False


def wait_until_ready(
    services: Sequence[Tuple[str, subprocess.Popen]],
    timeout_seconds: float,
    should_stop: Callable[[], bool],
) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if should_stop():
            return False
        for name, process in services:
            return_code = process.poll()
            if return_code is not None:
                print(
                    f"{name}启动失败（状态码 {return_code}）。请检查上方错误，"
                    "并确认 4173、8765 端口未被旧进程占用。",
                    file=sys.stderr,
                )
                return False
        if url_is_ready(FRONTEND_URL) and url_is_ready(HEALTH_URL):
            return True
        time.sleep(0.25)
    print(
        f"服务在 {timeout_seconds:.0f} 秒内未准备完成，请检查模型加载和端口状态。",
        file=sys.stderr,
    )
    return False


def main() -> int:
    if not VENV_PYTHON.is_file():
        print("缺少 .venv，请先按照 README 安装 Python 依赖。", file=sys.stderr)
        return 2

    commands = (
        ("识别 API", (str(VENV_PYTHON), "-m", "backend.serve")),
        ("网页服务", (
            str(VENV_PYTHON),
            str(ROOT / "scripts" / "static_server.py"),
        )),
    )
    processes: List[subprocess.Popen] = []
    services: List[Tuple[str, subprocess.Popen]] = []
    stopping = False

    def request_stop(_signum=None, _frame=None) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)

    try:
        for name, command in commands:
            print("+", " ".join(command), flush=True)
            process = subprocess.Popen(command, cwd=ROOT)
            processes.append(process)
            services.append((name, process))
        print("正在等待网页和识别模型准备完成……", flush=True)
        if not wait_until_ready(
            services,
            STARTUP_TIMEOUT_SECONDS,
            lambda: stopping,
        ):
            return 0 if stopping else 1
        print("服务已准备完成。", flush=True)
        print(f"网页：{FRONTEND_URL}", flush=True)
        print(f"识别 API：{HEALTH_URL}", flush=True)
        print("按 Ctrl+C 同时停止两个服务。", flush=True)

        while not stopping:
            for name, process in services:
                return_code = process.poll()
                if return_code is not None:
                    print(f"{name}已退出（状态码 {return_code}），正在停止其余服务。", file=sys.stderr)
                    return return_code or 1
            time.sleep(0.2)
        return 0
    finally:
        stop_processes(processes)


if __name__ == "__main__":
    raise SystemExit(main())
