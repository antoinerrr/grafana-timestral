# Timestral Forecasting

Forecast metrics from an existing Grafana datasource with a self-hosted Timestral service. Choose your data, select an outlook, and compare predictions with real observations.

Start with the [one-command demo and setup guide](https://github.com/antoinerrr/grafana-timestral). The plugin requires Grafana 13.0 or later and the supporting Python service; this community integration is not affiliated with Mistral AI or Grafana Labs.

## Use it

1. Add a **Timestral Forecasting** datasource. Enter a service URL reachable by Grafana and the service API token, then **Save & test**. The Compose example uses `http://timestral:8000`.
2. In a panel, choose Timestral, select an existing source datasource, and use its normal query editor. The source must return numeric time-series frames.
3. Choose **1h**, **2h**, **6h** or **24h** ahead. Set the dashboard range end into the future, for example `now+6h`.

The default history is seven days at five-minute intervals. See [settings by metric](https://github.com/antoinerrr/grafana-timestral#settings-by-metric) for CPU, memory, storage, power and throughput guidance. **Advanced** exposes history, sampling, custom forecast steps, physical bounds, units, display labels and source query JSON. Up to 16 series are supported per query. Use gauges or rates; convert cumulative counters to rates in the source query.

**Actual + forecast** shows observations, the median prediction, and a p10–p90 band. **Historical validation** withholds recent observations and compares predictions with them. **Summary statistics** reports the forecast endpoint, peak, change, mean absolute error and a last-value baseline. Lower error is better; a forecast is useful when it consistently improves on the baseline. The uncertainty band does not guarantee 80% coverage.

## How it handles data

The browser queries your selected datasource using Grafana's existing access controls. Grafana's server proxies inference requests and adds the encrypted API token. Metric names, labels, source query text and datasource credentials stay in Grafana. The inference service receives timestamps, values, opaque series IDs and forecast settings.

Samples are placed on a regular grid, retaining the latest finite observation in each bucket. Missing values stay missing until service-side validation and preprocessing. Queries require at least 64 grid slots, 48 finite observations, 50% coverage, and a recent sample. Historical validation also needs enough training data before its holdout.

Equivalent panels share results for 60 seconds, with at most four active requests per datasource instance. Cancellation removes queued work and unsubscribes active HTTP/source requests when no panel still needs them. Inference already running on the server may finish. This frontend plugin supports dashboards and Explore; Grafana alert rules and public dashboards are not supported.

## Development

```sh
npm ci
npm run typecheck
npm test
```

The build uses the standard `@grafana/create-plugin` scaffold and produces `dist/`. The plugin is unsigned; local Grafana installations must explicitly allow `antoinerrr-timestral-datasource`. See the project setup guide for a ready-to-run environment.
