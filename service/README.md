# Timestral inference service

A small CPU service that forecasts values supplied by the Grafana plugin. It has no metric queries, datasource credentials or Grafana dependency. Each series is forecast independently with the real Timestral model; there is no simulated inference mode.

## Run

The published image targets **Linux amd64**, with Python 3.12 and CPU-only PyTorch:

```sh
docker run --rm --platform linux/amd64 --cpus=4 --memory=8g \
  -p 127.0.0.1:8000:8000 -v timestral-cache:/cache \
  ghcr.io/antoinerrr/grafana-timestral:latest
```

For Kubernetes, use the [deployment example](../README.md#kubernetes). CI publishes `latest` and `sha-<commit>` after tests pass on `main`. To build a local development image, run `docker build --platform linux/amd64 -t timestral-service ./service` from the repository root.

Set the Grafana datasource's service URL to an address reachable **from Grafana**. The repository's Compose demo handles this for you. Keep one Uvicorn worker per container. Four CPU cores and 8 GiB is a generous starting limit for either supported model; measure your own history lengths and concurrency before reducing it.

The first start downloads pinned model weights into `/cache`; a persistent volume avoids downloading them again. Packages are installed at image build time, with a pinned base digest and dependency hashes. The process runs as UID/GID `10001`. A read-only root filesystem works with writable `/cache` and `/tmp` mounts. The weights are not bundled in the image and have a [separate license](../THIRD_PARTY_NOTICES.md).

## Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `TIMESTRAL_MODEL` | `5M` | Choose `5M` or `28M`; both use pinned revisions. |
| `TIMESTRAL_API_TOKEN_FILE` | unset | Read a Bearer token from a mounted secret. |
| `TIMESTRAL_API_TOKEN` | unset | Alternative to the token file; set only one. |
| `TORCH_NUM_THREADS` | `4` | CPU inference threads, from 1 to 128. Match the CPU limit. |
| `HF_HUB_CACHE` | `/cache/huggingface` | Writable model download cache. |
| `TIMESTRAL_CACHE_TTL_SECONDS` | `60` | Response cache lifetime; `0` disables it. |

Tokens must contain 16–4096 printable ASCII characters without whitespace. A trailing newline in a secret file is accepted. Restart the service after changing a token or model. Configure the same token in Grafana's secure datasource settings. Requests are checked with constant-time comparison. Without a token, use an isolated trusted network; token authentication does not replace TLS across untrusted networks.

Start with **5M, seven days of history and five-minute samples**. See [settings by metric](../README.md#settings-by-metric) for tested recommendations, sampling trade-offs and validation guidance.

## HTTP API

| Endpoint | Purpose | Token required when configured |
| --- | --- | --- |
| `GET /health/live` | HTTP process is alive. | No |
| `GET /health/ready` | 200 after weights load; otherwise 503. | No |
| `GET /status` | Model/revision, readiness, safe error codes, limits and counters. | Yes |
| `GET /metrics` | Prometheus operational counters; no series labels or values. | Yes |
| `POST /forecast` | Forecast caller-supplied observations. | Yes |

Send `Content-Type: application/json` and, if configured, `Authorization: Bearer <token>`. Generate a complete example request:

```python
import math
import time

step, count = 300, 2016
end = int(time.time()) // step * step
request = {
    "series": [{
        "id": "series-1",
        "timestamps": [end - (count - 1 - i) * step for i in range(count)],
        "values": [50 + 10 * math.sin(i * 2 * math.pi / 288) for i in range(count)],
        "min": 0,
    }],
    "step_seconds": step,
    "prediction_length": 72,
    "backtest": True,
    "backtest_length": 72,
}
```

The response includes `model`, `revision`, `generated_at`, `cache_hit`, `inference_seconds` and `series`. Each series contains its `id`, normalized `observed` timestamps/values, future `forecast` timestamps and `p10`/`p50`/`p90` arrays, diagnostics and optional `backtest` results. Holdouts include actuals, predictions, median MAE, persistence MAE and interval coverage. Backtest inference receives only observations before the holdout. The p10–p90 band is a nominal 80% interval, not a calibrated guarantee. Optional `min`/`max` bounds clip all quantiles and are disclosed in diagnostics. Upstream symmetric averaging and nonnegative clipping remain enabled.

Each request allows 16 series, 32,768 context slots per series, 2,016 forecast/holdout steps and a 16 MiB body. Supply at least 64 timestamps, 48 finite observations, 50% coverage and an observation in the last three slots. Timestamps are increasing integer Unix seconds on the declared grid; nulls and missing slots remain gaps. The training prefix of a holdout must satisfy these same requirements. Validation returns 422, oversized bodies 413, and unsupported encoding/content type 415. Errors never echo submitted values or labels.

Inference runs serially with four admitted requests and a 30-second maximum queue wait. A full or expired queue returns 503 with `Retry-After: 15`. Active CPU inference cannot be cancelled by disconnecting the client. The response cache holds at most 32 entries/64 MiB in memory, never on disk; expired entries are removed on the next request. Model loading tries three times with 5/10-second waits; after failure, fix connectivity/cache permissions and restart. Advanced bounded overrides are `TIMESTRAL_MAX_ADMITTED_REQUESTS`, `TIMESTRAL_QUEUE_TIMEOUT_SECONDS`, `TIMESTRAL_CACHE_MAX_ENTRIES`, `TIMESTRAL_CACHE_MAX_MIB`, `TIMESTRAL_LOAD_ATTEMPTS` and `TIMESTRAL_LOAD_RETRY_SECONDS`.

## Test

Unit tests require no weights or PyTorch:

```sh
cd service
python -m pip install -r requirements-test.txt
python -m pytest -q
```

Exercise a running service with a synthetic wave and real model inference:

```sh
python service/smoke.py --url http://127.0.0.1:8000
```

Set the same model/token environment for this smoke command as the service. It checks pinned model identity, ordered finite quantiles and a historical holdout. Use Python 3.12 to regenerate the Linux dependency lock with the command at the top of `requirements.txt`; review the resulting changes before rebuilding.
