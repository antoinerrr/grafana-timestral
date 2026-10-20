# Timestral for Grafana

Forecast your existing metrics with a self-hosted [Mistral Timestral](https://github.com/mistralai/timestral) model. Pick a Grafana datasource, write its usual query, and choose how far ahead to look.

![Timestral demo](docs/demo.jpg)

## Try it

Requires Docker Compose and about 4 CPU cores / 8 GB RAM available to Docker.

```sh
git clone https://github.com/antoinerrr/grafana-timestral.git
cd grafana-timestral
docker compose up --build -d --wait
```

Open [localhost:3000](http://localhost:3000). The dashboard includes synthetic energy demand, traffic, forecasts, and a historical accuracy check. The first start downloads the model; subsequent starts reuse its cache.

Save a copy of the demo dashboard to keep your edits when the provisioned example is updated.

This local demo has no login and binds only to localhost. Keep it local. The inference image targets Linux amd64; Apple Silicon uses Docker emulation.

Stop with `docker compose down`. Add `-v` to remove saved dashboards and cached weights.

## Use your own Grafana

Requires Grafana 13 or later. Tested with 13.0.2.

1. Build the plugin with Node 22 or later:
   ```sh
   (cd plugin && npm ci && npm run build)
   ```
2. Copy `plugin/dist/` into your Grafana plugins directory as `antoinerrr-timestral-datasource`. Set `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=antoinerrr-timestral-datasource` and restart Grafana.
3. Run the [inference container](service/README.md) on a network Grafana can reach.
4. Add a **Timestral** datasource. Set the service URL, optionally its API token, then **Save & test**.
5. In a panel, choose **Timestral**, select your source datasource, and enter its normal time-series query. Choose a forecast duration and run it.

Use a **Time series** panel and extend its time range into the future, for example `now-18h` to `now+6h`. The forecast starts at the earlier of now and the dashboard's range end. History is fetched separately, so the visible range does not limit training data.

**Forecast** shows observations, an orange median prediction, and a blue p10–p90 band with visible bounds. **Backtest** predicts the last part of the history, then compares it with the actual values. **Summary** provides current/forecast values and error scores for stat or table panels. Advanced settings control history, sampling, holdout duration, units, and physical bounds.

## Settings by metric

Start with **5M, 7 days of history, 5-minute samples, a 6-hour forecast and historical validation on**. These are starting points from our infrastructure tests; the behavior of your series matters more than its metric name.

| Metric | History / sampling | Guidance |
| --- | --- | --- |
| **CPU usage** | 7d / 5m | Good for the expected load level. One-minute sampling or 14d history gave only small improvements (~2%); neither reliably recovered spikes. |
| **Memory usage** | 7d / 5m | Keep the same hosts in the aggregate. One-minute sampling gave a small, uncertain gain and did not improve larger misses. |
| **Storage usage** | 7d / 5m | Useful for steady growth. Avoid history spanning capacity changes; 14d hurt our tested volume. A short forecast is not a reliable disk-full date. |
| **Power demand** | 7d / 5m | Useful for demand levels and uncertainty. More history or finer sampling did not consistently improve accuracy. |
| **Bursty throughput** | 7d / 5m | Forecast a rate, not a cumulative counter. Our read-throughput test beat the last-value baseline but still missed large bursts. More amplitude does not make peak timing predictable. |

Choose the forecast duration you need. **1h or 2h** gives a shorter operational view; **6h** suits a longer outlook. In our tests, requesting a shorter forecast did not improve predictions at the same lead time.

### Trying one-minute samples

1. Set **Sample interval** to **60 seconds**.
2. Reselect the forecast duration. For **6h**, both forecast and holdout need **360 steps** instead of 72.
3. Check the source query's minimum interval and that it supplies data at this resolution.

Keep history unchanged when comparing sampling. With seven days of history, one-minute samples reduced CPU MAE by **1.9%** and memory MAE by **1.4%**, but neither gain was reliable. They requested **5× as many samples** and took roughly **3–4×** the inference time. Five minutes remains the simpler default. Sampling `rate(counter[5m])` every minute still measures a five-minute rate.

### Check the fit

Compare several historical ranges with the same forecast duration and target timestamps. **MAE** should consistently beat **Naive MAE**, which repeats the last observation. Also check the curves and **P10–P90 coverage**: this is a nominal 80% interval, not a guarantee. A smooth median can be appropriate when spike timing is uncertain.

History includes the holdout: **24h history + 6h backtest = 18h training**. Use only available, relevant history; older deployments, resizes or membership changes can reduce accuracy. Set bounds only for known limits, such as **0–100** for percentages or **0** for nonnegative values. Bounds clip predictions; they do not improve the model.

The comparisons used 28 historical six-hour windows per signal, with settings selected on the first half and evaluated on the second where applicable. These are retrospective results. **28M** improved average error by less than 1% on each of four tested signals at roughly 2.3× the compute time, so **5M** remains the default.

To try the larger model:

```sh
TIMESTRAL_MODEL=28M docker compose up -d --wait
```

## How it works

```text
Grafana datasource → numeric samples → Timestral container → forecast panels
```

The plugin uses the selected datasource's own query editor and permissions. Only timestamps, numeric values, bounds, and opaque series IDs reach the inference service. Metric names, labels, queries, and datasource credentials stay in Grafana. The service has no Prometheus, Mimir, or Grafana connection configuration.

Supports up to 16 independent numeric time series per query. Each needs a time field, at least 64 sample slots, 48 finite values, and 50% coverage. Logs, traces, streaming queries, public dashboards, and Grafana-managed alerting are not supported. Compatibility depends on the source returning standard Grafana time-series frames.

## Development

```sh
cd plugin
npm ci
npm run typecheck
npm test
```

Python test and API instructions are in [service/README.md](service/README.md). CI tests the plugin, service, and a real-model container request.

## License

The integration is [Apache-2.0](LICENSE). Model weights are downloaded separately under Mistral's **Modified MIT** terms, including a commercial-license requirement above the stated $20M monthly revenue threshold. See [third-party notices](THIRD_PARTY_NOTICES.md). This is an independent community project.
