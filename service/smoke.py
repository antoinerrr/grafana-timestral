"""Exercise a running service with synthetic data, including real inference and a holdout."""
import argparse
import json
import math
import time
import urllib.error
import urllib.request

from settings import Settings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    parser.add_argument("--wait-seconds", type=int, default=180)
    args = parser.parse_args()
    settings = Settings.from_env()
    headers = {"Content-Type": "application/json"}
    if settings.api_token:
        headers["Authorization"] = "Bearer " + settings.api_token

    deadline = time.monotonic() + args.wait_seconds
    while True:
        try:
            with urllib.request.urlopen(args.url.rstrip("/") + "/health/ready", timeout=3) as response:
                assert response.status == 200
            break
        except (urllib.error.URLError, TimeoutError):
            if time.monotonic() >= deadline:
                raise SystemExit("Service did not become ready within the requested time.") from None
            time.sleep(2)
    step, count, horizon = 300, 576, 24
    end = int(time.time()) // step * step
    payload = {
        "series": [{"id": "synthetic-wave", "timestamps": [end - (count - 1 - i) * step for i in range(count)],
                    "values": [50 + 10 * math.sin(i * 2 * math.pi / 144) for i in range(count)], "min": 0}],
        "step_seconds": step, "prediction_length": horizon, "backtest": True, "backtest_length": horizon,
    }
    request = urllib.request.Request(args.url.rstrip("/") + "/forecast", data=json.dumps(payload).encode(), headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            result = json.load(response)
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"Forecast request failed with HTTP {exc.code}.") from None
    assert result["model"] == settings.model_id
    assert result["revision"] == settings.model_revision
    series = result["series"][0]
    forecast = series["forecast"]
    assert forecast["timestamps"][0] == end + step
    assert len(forecast["p50"]) == horizon
    for low, median, high in zip(forecast["p10"], forecast["p50"], forecast["p90"]):
        assert all(math.isfinite(x) for x in (low, median, high))
        assert low <= median <= high
    assert series["backtest"]["valid_points"] == horizon
    assert series["backtest"]["training_end_timestamp"] < series["backtest"]["timestamps"][0]
    print(f"Smoke passed: {result['model']}, {horizon} forecast steps + holdout, {result['inference_seconds']:.3f}s")


if __name__ == "__main__":
    main()
