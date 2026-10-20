# Timestral for Grafana

Forecast your existing metrics with a self-hosted [Mistral Timestral](https://github.com/mistralai/timestral) model. Choose a datasource, enter its usual query, and pick a forecast duration.

![Timestral demo](docs/demo.jpg)

## Try it

Requires Docker Compose with 4 CPU cores and 8 GB RAM available.

```sh
git clone https://github.com/antoinerrr/grafana-timestral.git
cd grafana-timestral
docker compose up --build -d --wait
```

Open [localhost:3000](http://localhost:3000). The demo includes synthetic data, forecasts and historical validation. It has no login and binds only to localhost. The first start downloads the model. The CPU image is Linux amd64; Apple Silicon uses emulation.

## Use your own Grafana

Requires **Grafana 13+** and **Node 22+** to build the plugin.

1. Build:
   ```sh
   (cd plugin && npm ci && npm run build)
   ```
2. Copy `plugin/dist/` into Grafana's plugins directory as `antoinerrr-timestral-datasource`. Set `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=antoinerrr-timestral-datasource` and restart Grafana.
3. Start the service with [Kubernetes below](#kubernetes) or [Docker](service/README.md#run).
4. Add a **Timestral** datasource, enter the service URL, and **Save & test**.
5. In a **Time series** panel, select Timestral, choose your source datasource and enter its query. Select **6h** and set the dashboard range to `now-18h` → `now+6h`.

The orange line is the median forecast; blue shows P10–P90. **Historical validation** compares a forecast with withheld observations. **Summary statistics** provides values and error scores.

## Kubernetes

Requires an existing `monitoring` namespace, a default StorageClass and a Linux amd64 node.

```sh
kubectl apply -n monitoring -f https://raw.githubusercontent.com/antoinerrr/grafana-timestral/main/deploy/kubernetes.yaml
kubectl rollout status -n monitoring deployment/timestral --timeout=15m
```

For Grafana in the same cluster, use **`http://timestral.monitoring.svc.cluster.local:8000`**.

The [manifest](deploy/kubernetes.yaml) runs **5M**, requests **2 CPU / 2 GiB**, allows **4 CPU / 8 GiB**, and keeps weights on a **1 GiB PVC**. These are generous starting values; no GPU is needed. The service is internal. Optional API-token setup is in the [service guide](service/README.md#settings).

CI publishes the smoke-tested image to **`ghcr.io/antoinerrr/grafana-timestral:latest`** after changes to `main`. A **`sha-<commit>`** tag is also available for reproducible deployments.

## Settings by metric

Start with **5M, 7 days of history, 5-minute samples, 6h ahead and validation on**. These are starting points from our tests, not universal optima.

| Metric | Guidance |
| --- | --- |
| CPU | Keep 7d / 5m. Finer sampling or 14d history gave only small gains; spikes remained difficult. |
| Memory | Keep 7d / 5m and stable node membership. One-minute sampling did not reliably improve the fit. |
| Storage usage | Good for steady growth. Avoid history spanning a resize; do not extrapolate a short forecast into a disk-full date. |
| Power | Forecast demand levels and uncertainty. More history or finer sampling did not consistently help. |
| Bursty throughput | Query rates rather than counters. Average error can improve while large bursts remain unpredictable. |

One-minute sampling reduced CPU/memory MAE by only **1.9% / 1.4%**, with uncertain gains and **3–4×** the inference time. To try it, set **Sample interval = 60s**, reselect **6h** (**360 forecast and holdout steps**), and check the source's minimum interval. Sampling a five-minute rate every minute still measures a five-minute rate.

Compare several historical ranges: **MAE** should beat **Naive MAE**, which repeats the last value. Check P10–P90 coverage too; 80% is nominal, not guaranteed. History includes the holdout: **24h history − 6h holdout = 18h training**. Set bounds only for known limits, such as 0–100%.

The tests used 28 historical six-hour windows per metric. Shorter horizons did not improve the same lead times. **28M** gained less than 1% on four tested signals at roughly 2.3× the compute cost; **5M** remains the default.

## How it works

```text
Grafana datasource → numeric samples → Timestral service → forecast panels
```

Queries, labels and credentials stay in Grafana. The service receives values and timestamps. Supports up to 16 numeric time series per query; logs, traces, streaming, public dashboards and Grafana-managed alerting are unsupported.

For development, run `npm run typecheck && npm test` in `plugin/`. See the [service guide](service/README.md) for its API and tests.

## License

Integration: [Apache-2.0](LICENSE). Model weights: Mistral's **Modified MIT**, including a commercial-license requirement above the stated $20M monthly revenue threshold. See [third-party notices](THIRD_PARTY_NOTICES.md). Independent community project.
