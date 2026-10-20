"""A values-only Timestral inference service. No datasource or metric-query access."""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from contextlib import asynccontextmanager
import hashlib
import json
import logging
import secrets
import threading
import time
from typing import Annotated, Any

import numpy as np
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from settings import MAX_BODY_BYTES, MAX_CONTEXT, MAX_HORIZON, MAX_SERIES, MIN_CONTEXT, SOURCE_REVISION, VERSION, Settings

LOG = logging.getLogger("timestral_host")


class SeriesValidationError(ValueError):
    """Only fixed, public-safe validation messages may use this exception."""


class InputSeries(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, strict=True)
    id: str = Field(min_length=1, max_length=160)
    timestamps: list[Annotated[int, Field(ge=0, le=253402300799)]] = Field(min_length=MIN_CONTEXT, max_length=MAX_CONTEXT)
    values: list[float | None] = Field(min_length=MIN_CONTEXT, max_length=MAX_CONTEXT)
    min: float | None = Field(default=None, ge=-1e30, le=1e30)
    max: float | None = Field(default=None, ge=-1e30, le=1e30)

    @model_validator(mode="after")
    def matching_lengths(self):
        if len(self.timestamps) != len(self.values):
            raise ValueError("timestamps and values must have the same length")
        if self.min is not None and self.max is not None and self.min >= self.max:
            raise ValueError("min must be less than max")
        return self


class ForecastRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, strict=True)
    series: list[InputSeries] = Field(min_length=1, max_length=MAX_SERIES)
    step_seconds: int = Field(ge=1, le=86400)
    prediction_length: int = Field(default=72, ge=1, le=MAX_HORIZON)
    backtest: bool = False
    backtest_length: int = Field(default=72, ge=1, le=MAX_HORIZON)

    @model_validator(mode="after")
    def unique_ids(self):
        if len({item.id for item in self.series}) != len(self.series):
            raise ValueError("series ids must be unique")
        return self


def normalize_series(item: InputSeries, step: int) -> tuple[np.ndarray, np.ndarray]:
    """Fill omitted slots with NaN without interpolation or forward filling."""
    timestamps = np.asarray(item.timestamps, dtype=np.int64)
    if np.any(np.diff(timestamps) <= 0):
        raise SeriesValidationError("Timestamps must be strictly increasing.")
    offsets = timestamps - timestamps[0]
    if np.any(offsets % step):
        raise SeriesValidationError("Timestamps must lie on the declared step_seconds grid.")
    length = int(offsets[-1] // step + 1)
    if length > MAX_CONTEXT:
        raise SeriesValidationError(f"Context spans more than {MAX_CONTEXT} steps.")
    values = np.full(length, np.nan, dtype=np.float32)
    incoming = np.array([np.nan if v is None else v for v in item.values], dtype=np.float64)
    if np.any(np.isinf(incoming)) or np.any(np.abs(incoming[np.isfinite(incoming)]) > 1e30):
        raise SeriesValidationError("Values must be finite or null, with absolute value <= 1e30.")
    values[offsets // step] = incoming
    finite = np.isfinite(values)
    if finite.sum() < 48 or finite.mean() < 0.5:
        raise SeriesValidationError("Need at least 48 finite observations and 50% coverage.")
    if not finite[-3:].any():
        raise SeriesValidationError("Last three samples are missing; trim stale trailing history.")
    return timestamps[0] + np.arange(length, dtype=np.int64) * step, values


def to_json_values(values: np.ndarray) -> list[float | None]:
    return [float(v) if np.isfinite(v) else None for v in values]


def bounded_quantiles(forecast: Any, length: int, item: InputSeries) -> tuple[dict[str, list[float]], bool]:
    result: dict[str, list[float]] = {}
    clipped = False
    for name, level in (("p10", 0.1), ("p50", 0.5), ("p90", 0.9)):
        values = np.asarray(forecast.quantile(level), dtype=np.float64).reshape(-1)
        if len(values) != length or not np.all(np.isfinite(values)):
            raise RuntimeError("Invalid model output")
        bounded = np.clip(values, -np.inf if item.min is None else item.min,
                          np.inf if item.max is None else item.max)
        clipped = clipped or bool(np.any(bounded != values))
        result[name] = bounded.tolist()
    if not np.all(np.asarray(result["p10"]) <= np.asarray(result["p50"])) or not np.all(
            np.asarray(result["p50"]) <= np.asarray(result["p90"])):
        raise RuntimeError("Invalid model quantiles")
    return result, clipped


class Engine:
    def __init__(self, settings: Settings | None = None):
        self.settings = settings or Settings.from_env()
        self.forecaster: Any = None
        self.model_error: str | None = None
        self.loading = False
        self.lock = threading.Lock()
        self.load_lock = threading.Lock()
        self.stats_lock = threading.Lock()
        self.stop = threading.Event()
        self.admission = threading.BoundedSemaphore(self.settings.max_admitted_requests)
        self.cache: OrderedDict[str, tuple[float, bytes]] = OrderedDict()
        self.cache_bytes = 0
        self.last_success: float | None = None
        self.last_failure: str | None = None
        self._torch_configured = False
        self.counters = dict(requests=0, cache_hits=0, successes=0, failures=0, invalid_requests=0,
                             queue_rejections=0, admitted_requests=0, inference_seconds=0.0, model_load_failures=0)

    def _count(self, **values):
        with self.stats_lock:
            for key, increment in values.items():
                self.counters[key] += increment

    def _load_forecaster(self):
        import torch
        from timestral import TimestralForecaster
        if not self._torch_configured:
            torch.set_num_threads(self.settings.torch_threads)
            torch.set_num_interop_threads(1)
            self._torch_configured = True
        return TimestralForecaster.from_pretrained(
            self.settings.model_id, revision=self.settings.model_revision, device="cpu",
            cache_dir=self.settings.cache_dir)

    def load(self):
        """Retry startup downloads a bounded number of times; never load on a request."""
        if not self.load_lock.acquire(blocking=False):
            return
        self.loading = True
        try:
            for attempt in range(1, self.settings.load_attempts + 1):
                if self.stop.is_set():
                    break
                try:
                    self.forecaster = self._load_forecaster()
                    self.model_error = None
                    LOG.info("Model ready: %s at %s", self.settings.model_id, self.settings.model_revision)
                    return
                except Exception as exc:
                    self.model_error = "model_load_failed"
                    self._count(model_load_failures=1)
                    # Upstream exception text may contain filesystem paths, URLs or tokens.
                    LOG.error("Model load failed (%s), attempt %d/%d", type(exc).__name__, attempt,
                              self.settings.load_attempts)
                    if attempt < self.settings.load_attempts:
                        self.stop.wait(min(60, self.settings.load_retry_seconds * 2 ** (attempt - 1)))
        finally:
            self.loading = False
            self.load_lock.release()

    def status(self) -> dict:
        with self.stats_lock:
            counters = self.counters.copy()
        return {"ready": self.forecaster is not None, "loading": self.loading,
                "version": VERSION, "model": self.settings.model_id, "revision": self.settings.model_revision,
                "source_revision": SOURCE_REVISION, "device": "cpu",
                "model_error": self.model_error, "last_failure": self.last_failure,
                "last_success": self.last_success, **counters,
                "cache_entries": len(self.cache), "cache_bytes": self.cache_bytes,
                "cache_ttl_seconds": self.settings.cache_ttl_seconds,
                "limits": {"series": MAX_SERIES, "min_context_points": MIN_CONTEXT,
                           "context_points": MAX_CONTEXT, "prediction_length": MAX_HORIZON,
                           "request_bytes": MAX_BODY_BYTES,
                           "concurrent_requests": self.settings.max_admitted_requests,
                           "queue_timeout_seconds": self.settings.queue_timeout_seconds},
                "quantiles": [0.1, 0.5, 0.9],
                "interval_note": "p10–p90 is a nominal 80% prediction interval; calibration is not guaranteed",
                "backtest_note": "One holdout using only preceding observations; baseline repeats the last training observation",
                "model_postprocessing": "Official defaults: symmetric averaging and nonnegative clipping for wholly nonnegative contexts",
                "data_access": "Only caller-supplied values are forecast. No datasource access."}

    def metrics(self) -> str:
        state = self.status()
        descriptors = {
            "ready": ("gauge", "Whether the pinned model is ready for inference.", int(state["ready"])),
            "requests_total": ("counter", "Forecast requests submitted to the engine.", state["requests"]),
            "cache_hits_total": ("counter", "Requests served from the response cache.", state["cache_hits"]),
            "successes_total": ("counter", "Successful forecast requests including cache hits.", state["successes"]),
            "failures_total": ("counter", "Model inference failures.", state["failures"]),
            "invalid_requests_total": ("counter", "Invalid forecast requests.", state["invalid_requests"]),
            "queue_rejections_total": ("counter", "Admission or queue timeout rejections.", state["queue_rejections"]),
            "admitted_requests": ("gauge", "Running and admitted waiting requests.", state["admitted_requests"]),
            "inference_seconds_total": ("counter", "Elapsed inference time excluding cache hits and queue wait.", state["inference_seconds"]),
            "model_load_failures_total": ("counter", "Failed startup model-load attempts.", state["model_load_failures"]),
            "cache_bytes": ("gauge", "Serialized response bytes retained in memory.", state["cache_bytes"]),
            "cache_entries": ("gauge", "Response entries retained in memory.", state["cache_entries"]),
        }
        lines = []
        for name, (kind, help_text, value) in descriptors.items():
            metric = "timestral_" + name
            lines.extend((f"# HELP {metric} {help_text}", f"# TYPE {metric} {kind}", f"{metric} {value}"))
        return "\n".join(lines) + "\n"

    def _expire_cache(self, now: float):
        expired = [key for key, (created, _) in self.cache.items()
                   if now - created >= self.settings.cache_ttl_seconds]
        for key in expired:
            self.cache_bytes -= len(self.cache.pop(key)[1])

    def run(self, request: ForecastRequest) -> dict:
        self._count(requests=1)
        if self.forecaster is None:
            raise HTTPException(503, "Model is not ready.", headers={"Retry-After": "15"})
        if not self.admission.acquire(blocking=False):
            self._count(queue_rejections=1)
            raise HTTPException(503, "Inference queue is full; retry later.", headers={"Retry-After": "15"})
        self._count(admitted_requests=1)
        acquired = False
        try:
            acquired = self.lock.acquire(timeout=self.settings.queue_timeout_seconds)
            if not acquired:
                self._count(queue_rejections=1)
                raise HTTPException(503, "Inference queue wait expired; retry later.", headers={"Retry-After": "15"})
            key = hashlib.sha256(request.model_dump_json().encode()).hexdigest()
            self._expire_cache(time.monotonic())
            cached = self.cache.get(key)
            if cached is not None:
                self.cache.move_to_end(key)
                self._count(cache_hits=1, successes=1)
                response = json.loads(cached[1])
                response["cache_hit"] = True
                return response
            started = time.monotonic()
            try:
                response = self._compute(request)
                encoded = json.dumps(response, allow_nan=False, separators=(",", ":")).encode()
            except SeriesValidationError as exc:
                self._count(invalid_requests=1)
                raise HTTPException(422, str(exc)) from None
            except Exception as exc:
                self.last_failure = "inference_failed"
                self._count(failures=1)
                LOG.error("Inference failed (%s)", type(exc).__name__)
                raise HTTPException(503, "Inference failed; retry later.") from None
            finally:
                self._count(inference_seconds=time.monotonic() - started)
            self.last_success = time.time()
            self.last_failure = None
            self._count(successes=1)
            if self.settings.cache_ttl_seconds and len(encoded) <= self.settings.cache_max_bytes:
                self.cache[key] = (time.monotonic(), encoded)
                self.cache_bytes += len(encoded)
                while len(self.cache) > self.settings.cache_max_entries or self.cache_bytes > self.settings.cache_max_bytes:
                    self.cache_bytes -= len(self.cache.popitem(last=False)[1][1])
            return response
        finally:
            if acquired:
                self.lock.release()
            self._count(admitted_requests=-1)
            self.admission.release()

    def _compute(self, request: ForecastRequest) -> dict:
        started = time.monotonic()
        # Validate every series before inference; invalid requests never trigger partial work.
        prepared = [(item, *normalize_series(item, request.step_seconds)) for item in request.series]
        for item, timestamps, values in prepared:
            if request.backtest:
                train = values[:-request.backtest_length]
                if len(train) < MIN_CONTEXT or np.isfinite(train).sum() < 48 or np.isfinite(train).mean() < 0.5:
                    raise SeriesValidationError("Backtest needs 64 preceding steps, 48 finite observations and 50% coverage.")
                if not np.isfinite(train[-3:]).any():
                    raise SeriesValidationError("Training history is stale at the backtest boundary.")
        output = []
        # Bounded batch of one keeps peak memory stable for long contexts.
        for item, timestamps, values in prepared:
            call_started = time.monotonic()
            prediction = self.forecaster.forecast(values[None, None, :], prediction_length=request.prediction_length)
            quantiles, clipped = bounded_quantiles(prediction, request.prediction_length, item)
            future_timestamps = timestamps[-1] + np.arange(1, request.prediction_length + 1) * request.step_seconds
            result = {"id": item.id,
                      "observed": {"timestamps": timestamps.tolist(), "values": to_json_values(values)},
                      "forecast": {"timestamps": future_timestamps.tolist(), **quantiles},
                      "backtest": None,
                      "diagnostics": {"context_points": len(values), "finite_points": int(np.isfinite(values).sum()),
                                      "missing_fraction": float(1 - np.isfinite(values).mean()),
                                      "context_start": int(timestamps[0]), "context_end": int(timestamps[-1]),
                                      "context_age_seconds": max(0.0, time.time() - int(timestamps[-1])),
                                      "bounds": {"min": item.min, "max": item.max}, "clipping_applied": clipped}}
            if request.backtest:
                length = request.backtest_length
                train, actual = values[:-length], values[-length:]
                # The holdout call receives only preceding data, never actuals being evaluated.
                held_prediction = self.forecaster.forecast(train[None, None, :], prediction_length=length)
                held, held_clipped = bounded_quantiles(held_prediction, length, item)
                valid = np.isfinite(actual)
                valid_count = int(valid.sum())
                baseline = float(train[np.isfinite(train)][-1])
                result["backtest"] = {
                    "length": length, "training_end_timestamp": int(timestamps[-length - 1]),
                    "timestamps": timestamps[-length:].tolist(), "actual": to_json_values(actual), **held,
                    "mae": float(np.abs(actual[valid] - np.asarray(held["p50"])[valid]).mean()) if valid_count else None,
                    "naive_mae": float(np.abs(actual[valid] - baseline).mean()) if valid_count else None,
                    "interval_coverage": float(((actual[valid] >= np.asarray(held["p10"])[valid]) &
                                                 (actual[valid] <= np.asarray(held["p90"])[valid])).mean()) if valid_count else None,
                    "valid_points": valid_count, "missing_fraction": float(1 - valid.mean()),
                    "clipping_applied": held_clipped, "naive_method": "last observation carried forward"}
            result["diagnostics"]["inference_seconds"] = time.monotonic() - call_started
            output.append(result)
        return {"model": self.settings.model_id, "revision": self.settings.model_revision, "device": "cpu",
                "step_seconds": request.step_seconds, "prediction_length": request.prediction_length,
                "generated_at": time.time(), "cache_hit": False,
                "inference_seconds": time.monotonic() - started, "series": output}


def create_app(engine: Engine | None = None, load_model: bool = True) -> FastAPI:
    engine = engine or Engine()

    @asynccontextmanager
    async def lifespan(api):
        if load_model:
            engine.loading = True
            threading.Thread(target=engine.load, daemon=True, name="model-loader").start()
        yield
        engine.stop.set()

    api = FastAPI(title="Timestral inference service", version=VERSION, lifespan=lifespan,
                  description="Forecast caller-supplied time series with pinned Timestral models.")
    api.state.engine = engine

    async def authenticate(raw: Request):
        token = engine.settings.api_token
        if token is None:
            return
        supplied = raw.headers.get("Authorization", "").encode("utf-8")
        expected = ("Bearer " + token).encode("ascii")
        if len(supplied) > 4103 or not secrets.compare_digest(supplied, expected):
            raise HTTPException(401, "Authentication required.", headers={"WWW-Authenticate": "Bearer"})

    @api.exception_handler(RequestValidationError)
    async def invalid_request(raw: Request, exc: RequestValidationError):
        return JSONResponse(status_code=422, content={"detail": "Invalid request; check the documented schema."})

    @api.exception_handler(Exception)
    async def internal_error(raw: Request, exc: Exception):
        LOG.error("Request failed (%s)", type(exc).__name__)
        return JSONResponse(status_code=500, content={"detail": "Internal service error."})

    @api.get("/health/live")
    def live():
        return {"status": "alive"}

    @api.get("/health/ready")
    def ready():
        if engine.forecaster is None:
            raise HTTPException(503, "Model is not ready.")
        return {"status": "ready"}

    @api.get("/status", dependencies=[Depends(authenticate)])
    def status():
        return engine.status()

    @api.get("/metrics", dependencies=[Depends(authenticate)], response_class=PlainTextResponse)
    def metrics():
        return PlainTextResponse(engine.metrics(), media_type="text/plain; version=0.0.4; charset=utf-8")

    @api.post("/forecast", dependencies=[Depends(authenticate)])
    async def forecast(raw: Request):
        # Authentication happens before accepting metric data. Stream bounds also cover chunked bodies.
        if raw.headers.get("Content-Encoding", "identity").lower() != "identity":
            raise HTTPException(415, "Compressed request bodies are not supported.")
        content_type = raw.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            raise HTTPException(415, "Use Content-Type: application/json.")
        body = bytearray()
        async for chunk in raw.stream():
            if len(body) + len(chunk) > MAX_BODY_BYTES:
                engine._count(invalid_requests=1)
                raise HTTPException(413, "Request body exceeds 16 MiB.")
            body.extend(chunk)
        try:
            request = ForecastRequest.model_validate_json(bytes(body))
        except ValidationError:
            # Pydantic's default error representation includes entire request values and labels.
            engine._count(invalid_requests=1)
            raise HTTPException(422, "Invalid forecast request; check the documented schema and limits.") from None
        return await asyncio.to_thread(engine.run, request)

    return api


app = create_app()
