"""Environment-backed configuration for the local recognition API."""

from __future__ import annotations

import os
from dataclasses import dataclass
from ipaddress import ip_address
from pathlib import Path
from typing import Tuple


BACKEND_DIR = Path(__file__).resolve().parent
DEFAULT_MODEL_PATH = BACKEND_DIR / "models" / "best_model.pt"
DEFAULT_HAND_TEMPLATE_LIBRARY_DIR = (
    BACKEND_DIR.parent / "datasets" / "private" / "hand_templates"
)
DEFAULT_ORIGINS = (
    "http://127.0.0.1:4173",
    "http://localhost:4173",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
)


def is_loopback_host(host: str) -> bool:
    normalized = host.strip().strip("[]").lower()
    if normalized == "localhost":
        return True
    try:
        return ip_address(normalized).is_loopback
    except ValueError:
        return False


def _read_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc


def _read_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number") from exc


def _read_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be true or false")


@dataclass(frozen=True)
class ApiSettings:
    host: str = "127.0.0.1"
    port: int = 8765
    model_path: Path = DEFAULT_MODEL_PATH
    device: str = "auto"
    minimum_confidence: float = 0.65
    hand_template_library_enabled: bool = False
    hand_template_library_dir: Path = DEFAULT_HAND_TEMPLATE_LIBRARY_DIR
    max_upload_bytes: int = 12 * 1024 * 1024
    minimum_width: int = 640
    minimum_height: int = 360
    maximum_dimension: int = 8192
    maximum_pixels: int = 24_000_000
    recognition_timeout_seconds: float = 45.0
    allowed_origins: Tuple[str, ...] = DEFAULT_ORIGINS
    enforce_loopback_clients: bool = True

    def validate(self) -> "ApiSettings":
        if not is_loopback_host(self.host):
            raise ValueError("The recognition API host must be a loopback address")
        if not 1 <= self.port <= 65535:
            raise ValueError("API port must be between 1 and 65535")
        if self.device not in {"auto", "cpu", "mps", "cuda"}:
            raise ValueError("Device must be auto, cpu, mps or cuda")
        if not 0.0 <= self.minimum_confidence <= 1.0:
            raise ValueError("Minimum confidence must be between 0 and 1")
        if self.max_upload_bytes <= 0:
            raise ValueError("Maximum upload size must be positive")
        if self.minimum_width <= 0 or self.minimum_height <= 0:
            raise ValueError("Minimum image dimensions must be positive")
        if self.maximum_dimension < max(self.minimum_width, self.minimum_height):
            raise ValueError("Maximum image dimension is smaller than the minimum")
        if self.maximum_pixels <= 0:
            raise ValueError("Maximum pixel count must be positive")
        if self.recognition_timeout_seconds <= 0:
            raise ValueError("Recognition timeout must be positive")
        if not self.allowed_origins:
            raise ValueError("At least one browser origin must be allowed")
        return self

    @classmethod
    def from_environment(cls) -> "ApiSettings":
        origins = tuple(
            origin.strip()
            for origin in os.environ.get(
                "MAHJONG_API_ALLOWED_ORIGINS",
                ",".join(DEFAULT_ORIGINS),
            ).split(",")
            if origin.strip()
        )
        settings = cls(
            host=os.environ.get("MAHJONG_API_HOST", "127.0.0.1"),
            port=_read_int("MAHJONG_API_PORT", 8765),
            model_path=Path(
                os.environ.get("MAHJONG_MODEL_PATH", str(DEFAULT_MODEL_PATH))
            ).expanduser(),
            device=os.environ.get("MAHJONG_DEVICE", "auto").lower(),
            minimum_confidence=_read_float("MAHJONG_MINIMUM_CONFIDENCE", 0.65),
            hand_template_library_enabled=_read_bool(
                "MAHJONG_HAND_TEMPLATE_LIBRARY_ENABLED",
                False,
            ),
            hand_template_library_dir=Path(
                os.environ.get(
                    "MAHJONG_HAND_TEMPLATE_LIBRARY_DIR",
                    str(DEFAULT_HAND_TEMPLATE_LIBRARY_DIR),
                )
            ).expanduser(),
            max_upload_bytes=_read_int(
                "MAHJONG_MAX_UPLOAD_BYTES",
                12 * 1024 * 1024,
            ),
            minimum_width=_read_int("MAHJONG_MINIMUM_WIDTH", 640),
            minimum_height=_read_int("MAHJONG_MINIMUM_HEIGHT", 360),
            maximum_dimension=_read_int("MAHJONG_MAXIMUM_DIMENSION", 8192),
            maximum_pixels=_read_int("MAHJONG_MAXIMUM_PIXELS", 24_000_000),
            recognition_timeout_seconds=_read_float(
                "MAHJONG_RECOGNITION_TIMEOUT_SECONDS",
                45.0,
            ),
            allowed_origins=origins,
        )
        return settings.validate()
