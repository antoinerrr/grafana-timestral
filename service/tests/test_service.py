import json
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app import Engine, ForecastRequest, InputSeries, create_app, normalize_series


class FakeResult:
    def __init__(self, value, length):
        self.value = value
        self.length = length

    def quantile(self, q):
        return np.full((1, 1, self.length), self.value + (q - 0.5) * 10)


class FakeForecaster:
    def __init__(self):
        self.calls = []

    def forecast(self, values, prediction_length):
        self.calls.append(values.copy())
        return FakeResult(values[np.isfinite(values)][-1], prediction_length)


def payload(length=144, **kwargs):
    return {"series": [{"id": "test", "timestamps": list(range(100000, 100000 + length * 300, 300)),
                        "values": list(range(length))}], "step_seconds": 300,
            "prediction_length": 12, **kwargs}


@pytest.fixture
def engine():
    engine = Engine()
    engine.forecaster = FakeForecaster()
    return engine


def test_missing_timestamp_slots_preserved_as_nan():
    data = payload()
    del data["series"][0]["timestamps"][40]
    del data["series"][0]["values"][40]
    data["series"][0]["values"][49] = None
    timestamps, values = normalize_series(InputSeries(**data["series"][0]), 300)
    assert len(values) == 144
    assert np.isnan(values[40])
    assert np.isnan(values[50])
    assert values[41] == 41
    assert timestamps[40] == 112000


@pytest.mark.parametrize("kind", ["unordered", "duplicate", "offgrid", "hugegap", "stale", "sparse"])
def test_bad_input_rejected(kind, engine):
    data = payload()
    series = data["series"][0]
    if kind == "unordered":
        series["timestamps"][9], series["timestamps"][10] = series["timestamps"][10], series["timestamps"][9]
    elif kind == "duplicate":
        series["timestamps"][10] = series["timestamps"][9]
    elif kind == "offgrid":
        series["timestamps"][10] += 1
    elif kind == "hugegap":
        series["timestamps"][-1] += 32768 * 300
    elif kind == "stale":
        series["values"][-3:] = [None] * 3
    elif kind == "sparse":
        series["values"][:100] = [None] * 100
    client = TestClient(create_app(engine, load_model=False))
    response = client.post("/forecast", json=data)
    assert response.status_code == 422, response.text
    assert engine.forecaster.calls == []


def test_holdout_never_sees_held_out_values(engine):
    data = payload(backtest=True, backtest_length=72)
    data["series"][0]["values"][72:] = [9000] * 72
    response = engine.run(ForecastRequest(**data))
    final_call, backtest_call = engine.forecaster.calls
    assert final_call.shape == (1, 1, 144)
    assert backtest_call.shape == (1, 1, 72)
    assert np.max(backtest_call) == 71
    held = response["series"][0]["backtest"]
    assert held["training_end_timestamp"] < held["timestamps"][0]
    assert held["mae"] == held["naive_mae"] == 8929
    assert held["interval_coverage"] == 0
    assert held["valid_points"] == 72


def test_holdout_empty_actual_reports_null_quality(engine):
    data = payload(backtest=True, backtest_length=72)
    # Keep final three samples finite, so exactly three are evaluated, not 72.
    data["series"][0]["values"][72:-3] = [None] * 69
    result = engine.run(ForecastRequest(**data))["series"][0]
    assert result["backtest"]["valid_points"] == 3
    assert result["backtest"]["missing_fraction"] == pytest.approx(69 / 72)
    assert result["observed"]["values"][72] is None


def test_insufficient_holdout_training_rejected_before_inference(engine):
    client = TestClient(create_app(engine, load_model=False))
    response = client.post("/forecast", json=payload(length=100, backtest=True, backtest_length=72))
    assert response.status_code == 422
    assert engine.forecaster.calls == []


def test_clipping_disclosed_and_intervals_ordered(engine):
    data = payload()
    data["series"][0].update(min=0, max=100)
    result = engine.run(ForecastRequest(**data))["series"][0]
    assert result["diagnostics"]["clipping_applied"]
    assert result["forecast"]["p10"] == [100] * 12
    assert result["forecast"]["p50"] == [100] * 12
    assert result["forecast"]["p90"] == [100] * 12


def test_cache_prevents_duplicate_inference(engine):
    request = ForecastRequest(**payload())
    first = engine.run(request)
    second = engine.run(request)
    assert not first["cache_hit"]
    assert second["cache_hit"]
    assert first["generated_at"] == second["generated_at"]
    assert len(engine.forecaster.calls) == 1


def test_unready_health_and_forecast_never_claim_success():
    engine = Engine()
    engine.model_error = "model_load_failed"
    client = TestClient(create_app(engine, load_model=False))
    assert client.get("/health/live").status_code == 200
    assert client.get("/health/ready").status_code == 503
    assert client.post("/forecast", json=payload()).status_code == 503
    assert client.get("/status").json()["model_error"] == "model_load_failed"


def test_inference_error_does_not_poison_cache_or_readiness(engine):
    def fail(*args, **kwargs):
        raise RuntimeError("simulated model failure")
    engine.forecaster.forecast = fail
    client = TestClient(create_app(engine, load_model=False))
    assert client.post("/forecast", json=payload()).status_code == 503
    assert not engine.cache
    assert engine.last_success is None
    assert engine.last_failure == "inference_failed"
    assert client.get("/health/ready").status_code == 200


def test_no_network_query_or_promql_interface(engine):
    client = TestClient(create_app(engine, load_model=False))
    assert client.get("/api/v1/query", params={"query": "up"}).status_code == 404
    data = payload()
    data["url"] = "http://metadata.invalid"
    assert client.post("/forecast", json=data).status_code == 422


@pytest.mark.parametrize("bad_value", [float("inf"), float("nan"), -float("inf")])
def test_nonfinite_input_rejected(bad_value):
    data = payload()
    data["series"][0]["values"][10] = bad_value
    with pytest.raises(ValidationError):
        ForecastRequest(**data)


def test_authentication_protects_data_endpoints_before_body_processing():
    from settings import Settings
    secured = Engine(Settings(api_token="test-token-do-not-reuse"))
    secured.forecaster = FakeForecaster()
    client = TestClient(create_app(secured, load_model=False))
    auth = {"Authorization": "Bearer test-token-do-not-reuse"}
    for path in ("/status", "/metrics"):
        assert client.get(path).status_code == 401
        assert client.get(path, headers={"Authorization": "Bearer wrong"}).status_code == 401
        response = client.get(path, headers=auth)
        assert response.status_code == 200
        assert "test-token-do-not-reuse" not in response.text
    assert client.post("/forecast", content="not json").status_code == 401
    assert client.post("/forecast", json=payload(), headers=auth).status_code == 200
    assert len(secured.forecaster.calls) == 1
    assert client.get("/health/live").json() == {"status": "alive"}
    assert client.get("/health/ready").json() == {"status": "ready"}


@pytest.mark.parametrize("failure", ["schema", "timestamps", "internal"])
def test_errors_never_echo_payload_or_internal_details(engine, caplog, failure):
    data = payload()
    secret = "private-customer-label-45678"
    data["series"][0]["id"] = secret
    if failure == "schema":
        data["series"][0]["values"][5] = secret
    elif failure == "timestamps":
        data["series"][0]["timestamps"][5] += 1
    else:
        def fail(*args, **kwargs):
            raise ValueError(secret)
        engine.forecaster.forecast = fail
    client = TestClient(create_app(engine, load_model=False))
    response = client.post("/forecast", json=data)
    assert response.status_code == (503 if failure == "internal" else 422)
    for result in (response.text, client.get("/status").text, client.get("/metrics").text, caplog.text):
        assert secret not in result


def test_streamed_oversize_body_rejected_before_inference(engine, monkeypatch):
    import app
    monkeypatch.setattr(app, "MAX_BODY_BYTES", 128)
    client = TestClient(create_app(engine, load_model=False))
    response = client.post("/forecast", content=iter([b" " * 64, b" " * 65]),
                           headers={"Content-Type": "application/json"})
    assert response.status_code == 413
    assert engine.forecaster.calls == []


def test_compressed_and_non_json_bodies_rejected(engine):
    client = TestClient(create_app(engine, load_model=False))
    assert client.post("/forecast", json=payload(), headers={"Content-Encoding": "gzip"}).status_code == 415
    assert client.post("/forecast", content=json.dumps(payload())).status_code == 415


def test_model_load_retries_are_bounded_and_safe(monkeypatch, caplog):
    engine = Engine()
    calls, delays = [], []
    def fail():
        calls.append(1)
        raise RuntimeError("private-download-url?token=secret")
    monkeypatch.setattr(engine, "_load_forecaster", fail)
    monkeypatch.setattr(engine.stop, "wait", lambda delay: delays.append(delay))
    engine.load()
    assert len(calls) == 3
    assert delays == [5, 10]
    assert not engine.loading
    assert not engine.status()["ready"]
    assert engine.status()["model_error"] == "model_load_failed"
    assert engine.status()["model_load_failures"] == 3
    assert "private-download-url" not in caplog.text
    assert "private-download-url" not in json.dumps(engine.status())


@pytest.mark.parametrize("variant,revision", [
    ("5M", "bdd20cfc15a3fea0e4cb5ccef37f8d3ca7aa335f"),
    ("28M", "49b26409ac87b5935539a5d8ffe7f397b720db47"),
])
def test_loader_uses_selected_pinned_checkpoint(monkeypatch, variant, revision):
    import sys
    from types import SimpleNamespace
    from settings import Settings
    calls = []
    class Loader:
        @staticmethod
        def from_pretrained(*args, **kwargs):
            calls.append((args, kwargs))
            return FakeForecaster()
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(set_num_threads=lambda _: None,
                                                              set_num_interop_threads=lambda _: None))
    monkeypatch.setitem(sys.modules, "timestral", SimpleNamespace(TimestralForecaster=Loader))
    engine = Engine(Settings(model_variant=variant))
    engine.load()
    assert calls == [((f"mistralai/Timestral-{variant}",), {
        "revision": revision, "device": "cpu", "cache_dir": "/cache/huggingface"})]
    assert engine.run(ForecastRequest(**payload()))["revision"] == revision


def test_full_queue_rejects_then_accepts_next_request(engine):
    from fastapi import HTTPException
    for _ in range(engine.settings.max_admitted_requests):
        assert engine.admission.acquire(blocking=False)
    with pytest.raises(HTTPException) as exc:
        engine.run(ForecastRequest(**payload()))
    assert exc.value.status_code == 503
    assert exc.value.headers["Retry-After"] == "15"
    for _ in range(engine.settings.max_admitted_requests):
        engine.admission.release()
    assert engine.run(ForecastRequest(**payload()))["series"]
    assert engine.status()["admitted_requests"] == 0


def test_queue_wait_is_bounded_and_releases_admission_slot():
    from fastapi import HTTPException
    from settings import Settings
    engine = Engine(Settings(queue_timeout_seconds=1))
    engine.forecaster = FakeForecaster()
    engine.lock.acquire()
    try:
        with pytest.raises(HTTPException) as exc:
            engine.run(ForecastRequest(**payload()))
        assert exc.value.status_code == 503
    finally:
        engine.lock.release()
    assert engine.run(ForecastRequest(**payload()))["series"]
    assert engine.status()["admitted_requests"] == 0


def test_cache_expiration_and_entry_bounds():
    from settings import Settings
    engine = Engine(Settings(cache_max_entries=2))
    engine.forecaster = FakeForecaster()
    for length in (144, 145, 146):
        engine.run(ForecastRequest(**payload(length=length)))
    assert len(engine.cache) == 2
    assert engine.cache_bytes == sum(len(value[1]) for value in engine.cache.values())
    for key, (created, encoded) in list(engine.cache.items()):
        engine.cache[key] = (created - 61, encoded)
    assert not engine.run(ForecastRequest(**payload(length=146)))["cache_hit"]
    assert len(engine.cache) == 1
    assert len(engine.forecaster.calls) == 4


@pytest.mark.parametrize("overrides", [{"cache_ttl_seconds": 0}, {"cache_max_bytes": 128}])
def test_disabled_or_tiny_cache_never_retains_payload(overrides):
    from settings import Settings
    engine = Engine(Settings(**overrides))
    engine.forecaster = FakeForecaster()
    for _ in range(2):
        engine.run(ForecastRequest(**payload()))
    assert not engine.cache
    assert engine.cache_bytes == 0
    assert len(engine.forecaster.calls) == 2


def test_all_series_validated_before_any_model_call(engine):
    data = payload()
    data["series"].append({**data["series"][0], "id": "bad", "values": [None] * 144})
    client = TestClient(create_app(engine, load_model=False))
    assert client.post("/forecast", json=data).status_code == 422
    assert engine.forecaster.calls == []
