# Linux amd64 CPU image; both stages use the same immutable Python base.
FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258 AS builder
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /build
COPY requirements.txt requirements-build.txt ./
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --require-hashes -r requirements-build.txt \
    && /opt/venv/bin/pip install --no-cache-dir --require-hashes --no-build-isolation -r requirements.txt \
    && /opt/venv/bin/pip check

FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258
LABEL org.opencontainers.image.title="Timestral forecasting service" \
      org.opencontainers.image.description="Values-only CPU forecasting for Grafana" \
      org.opencontainers.image.source="https://github.com/antoinerrr/grafana-timestral"
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HUB_CACHE=/cache/huggingface \
    HF_XET_CACHE=/cache/xet \
    HF_HUB_DISABLE_TELEMETRY=1 \
    DO_NOT_TRACK=1 \
    TORCH_NUM_THREADS=4 \
    OMP_NUM_THREADS=4
RUN groupadd --gid 10001 timestral \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /cache --shell /usr/sbin/nologin timestral \
    && mkdir -p /cache/huggingface /cache/xet \
    && chown -R 10001:10001 /cache
COPY --from=builder /opt/venv /opt/venv
WORKDIR /app
COPY app.py settings.py smoke.py ./
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=20s --timeout=3s --start-period=180s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health/ready', timeout=2).close()"]
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--limit-concurrency", "32", "--timeout-keep-alive", "5", "--no-access-log"]
