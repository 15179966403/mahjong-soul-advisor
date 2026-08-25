"""FastAPI application exposing the local screenshot-recognition service."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import Callable, Optional, Set
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from backend.config import ApiSettings, is_loopback_host
from backend.recognition import RecognitionError, RecognitionService


ALLOWED_MEDIA_TYPES = {
    "image/jpeg": "JPEG",
    "image/jpg": "JPEG",
    "image/png": "PNG",
    "image/webp": "WEBP",
}


class ApiError(RuntimeError):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


def _recognition_status(code: str) -> int:
    return {
        "INVALID_IMAGE": 400,
        "UNSUPPORTED_IMAGE_FORMAT": 415,
        "IMAGE_TOO_SMALL": 422,
        "IMAGE_DIMENSIONS_EXCEEDED": 413,
        "TABLE_NOT_FOUND": 422,
        "MODEL_LOAD_FAILED": 503,
        "HAND_TEMPLATE_LIBRARY_FAILED": 503,
    }.get(code, 500)


def _error_response(
    request: Request,
    status_code: int,
    code: str,
    message: str,
) -> JSONResponse:
    request_id = getattr(request.state, "request_id", None)
    error = {"code": code, "message": message}
    if request_id is not None:
        error["requestId"] = request_id
    response = JSONResponse(status_code=status_code, content={"error": error})
    if request_id is not None:
        response.headers["X-Request-ID"] = request_id
    return response


async def _read_limited_body(request: Request, limit: int) -> bytes:
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            declared_length = int(content_length)
        except ValueError as exc:
            raise ApiError(400, "INVALID_CONTENT_LENGTH", "Content-Length 无效") from exc
        if declared_length < 0:
            raise ApiError(400, "INVALID_CONTENT_LENGTH", "Content-Length 无效")
        if declared_length > limit:
            raise ApiError(
                413,
                "IMAGE_FILE_TOO_LARGE",
                f"图片文件不能超过 {limit // (1024 * 1024)} MB",
            )

    payload = bytearray()
    async for chunk in request.stream():
        payload.extend(chunk)
        if len(payload) > limit:
            raise ApiError(
                413,
                "IMAGE_FILE_TOO_LARGE",
                f"图片文件不能超过 {limit // (1024 * 1024)} MB",
            )
    if not payload:
        raise ApiError(400, "EMPTY_IMAGE", "请求体中没有图片数据")
    return bytes(payload)


def create_app(
    settings: Optional[ApiSettings] = None,
    service_factory: Callable[..., RecognitionService] = RecognitionService,
) -> FastAPI:
    api_settings = (settings or ApiSettings.from_environment()).validate()

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        application.state.recognition_service = None
        application.state.model_error = None
        application.state.recognition_semaphore = asyncio.Semaphore(1)
        application.state.pending_recognitions = set()
        try:
            application.state.recognition_service = service_factory(
                model_path=api_settings.model_path,
                device=api_settings.device,
                minimum_confidence=api_settings.minimum_confidence,
                hand_template_library_dir=(
                    api_settings.hand_template_library_dir
                    if api_settings.hand_template_library_enabled
                    else None
                ),
            )
        except (RecognitionError, ValueError, RuntimeError) as exc:
            application.state.model_error = exc
        yield
        application.state.recognition_service = None
        pending = tuple(application.state.pending_recognitions)
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        application.state.pending_recognitions.clear()

    application = FastAPI(
        title="Mahjong Soul Advisor Recognition API",
        version="1",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    application.state.settings = api_settings
    application.add_middleware(
        CORSMiddleware,
        allow_origins=list(api_settings.allowed_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "X-Request-ID"],
        expose_headers=["X-Request-ID"],
        max_age=600,
    )

    @application.middleware("http")
    async def local_request_guard(request: Request, call_next):
        request.state.request_id = uuid4().hex
        client_host = request.client.host if request.client is not None else ""
        if api_settings.enforce_loopback_clients and not is_loopback_host(client_host):
            return _error_response(
                request,
                403,
                "LOCAL_ACCESS_ONLY",
                "识别服务只接受来自本机的请求",
            )
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        response.headers["Cache-Control"] = "no-store"
        return response

    @application.exception_handler(ApiError)
    async def handle_api_error(request: Request, exc: ApiError):
        return _error_response(
            request,
            exc.status_code,
            exc.code,
            exc.message,
        )

    @application.exception_handler(RecognitionError)
    async def handle_recognition_error(request: Request, exc: RecognitionError):
        return _error_response(
            request,
            _recognition_status(exc.code),
            exc.code,
            exc.message,
        )

    @application.exception_handler(RequestValidationError)
    async def handle_validation_error(request: Request, exc: RequestValidationError):
        del exc
        return _error_response(
            request,
            422,
            "INVALID_REQUEST",
            "请求参数无效",
        )

    @application.exception_handler(StarletteHTTPException)
    async def handle_http_error(request: Request, exc: StarletteHTTPException):
        code = "ROUTE_NOT_FOUND" if exc.status_code == 404 else "HTTP_ERROR"
        message = "接口不存在" if exc.status_code == 404 else str(exc.detail)
        return _error_response(request, exc.status_code, code, message)

    @application.exception_handler(Exception)
    async def handle_unexpected_error(request: Request, exc: Exception):
        del exc
        return _error_response(
            request,
            500,
            "INTERNAL_ERROR",
            "识别服务发生内部错误",
        )

    @application.get("/api/health")
    async def health(request: Request):
        service = request.app.state.recognition_service
        model_error = request.app.state.model_error
        if service is None:
            message = "识别模型未能加载"
            if isinstance(model_error, RecognitionError):
                message = model_error.message
            return _error_response(
                request,
                503,
                "MODEL_NOT_READY",
                message,
            )
        return {
            "status": "ok",
            "apiVersion": 1,
            "model": {
                "loaded": True,
                "architecture": service.classifier.architecture,
                "device": str(service.classifier.device),
            },
            "handTemplates": {
                "enabled": service.hand_template_matcher is not None,
                "samples": (
                    len(service.hand_template_matcher.samples)
                    if service.hand_template_matcher is not None
                    else 0
                ),
                "classes": (
                    len(service.hand_template_matcher.coverage())
                    if service.hand_template_matcher is not None
                    else 0
                ),
            },
            "limits": {
                "maxUploadBytes": api_settings.max_upload_bytes,
                "maxPixels": api_settings.maximum_pixels,
                "timeoutSeconds": api_settings.recognition_timeout_seconds,
            },
        }

    @application.post("/api/recognize")
    async def recognize(request: Request):
        media_type = request.headers.get("content-type", "").split(";", 1)[0].lower()
        expected_format = ALLOWED_MEDIA_TYPES.get(media_type)
        if expected_format is None:
            raise ApiError(
                415,
                "UNSUPPORTED_MEDIA_TYPE",
                "Content-Type 必须是 image/png、image/jpeg 或 image/webp",
            )

        service = request.app.state.recognition_service
        if service is None:
            raise ApiError(503, "MODEL_NOT_READY", "识别模型尚未就绪")

        payload = await _read_limited_body(request, api_settings.max_upload_bytes)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + api_settings.recognition_timeout_seconds
        semaphore = request.app.state.recognition_semaphore
        try:
            await asyncio.wait_for(
                semaphore.acquire(),
                timeout=api_settings.recognition_timeout_seconds,
            )
        except asyncio.TimeoutError as exc:
            raise ApiError(
                504,
                "RECOGNITION_TIMEOUT",
                "等待识别服务超时，请稍后重试",
            ) from exc

        async def run_recognition():
            try:
                result = await asyncio.to_thread(
                    service.recognize_bytes,
                    payload,
                    (expected_format,),
                    api_settings.minimum_width,
                    api_settings.minimum_height,
                    api_settings.maximum_dimension,
                    api_settings.maximum_pixels,
                )
                return result.to_dict()
            finally:
                semaphore.release()

        task = asyncio.create_task(run_recognition())
        remaining = max(0.001, deadline - loop.time())
        try:
            return await asyncio.wait_for(asyncio.shield(task), timeout=remaining)
        except asyncio.TimeoutError as exc:
            pending: Set[asyncio.Task] = request.app.state.pending_recognitions
            pending.add(task)

            def finish_pending(finished: asyncio.Task) -> None:
                pending.discard(finished)
                if not finished.cancelled():
                    finished.exception()

            task.add_done_callback(finish_pending)
            raise ApiError(
                504,
                "RECOGNITION_TIMEOUT",
                "截图识别超时，请稍后重试或换用分辨率更低的截图",
            ) from exc

    return application


app = create_app()
