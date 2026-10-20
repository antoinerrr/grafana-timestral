import {
  DataSourceApi,
  DataSourceInstanceSettings,
  DataQueryRequest,
  DataQueryResponse,
  DataFrame,
  LoadingState,
  dateTime,
} from '@grafana/data';
import { getBackendSrv, getDataSourceSrv, getTemplateSrv } from '@grafana/runtime';
import {
  Observable,
  firstValueFrom,
  from,
  of,
  forkJoin,
  isObservable,
  filter,
  timeout,
  switchMap,
  map,
  take,
  catchError,
  throwError,
  defer,
  finalize,
  tap,
  shareReplay,
  throwIfEmpty,
} from 'rxjs';
import { extractSeries, resultFrames } from './frames';
import {
  ForecastRequest,
  ForecastResponse,
  LEGACY_PLUGIN_ID,
  PLUGIN_ID,
  ServiceStatus,
  TimestralOptions,
  TimestralQuery,
  queryDefaults,
} from './types';
import { queryErrors, serviceUrlError } from './validation';

interface CachedResult {
  response: ForecastResponse;
  units: Record<string, string | undefined>;
  labels: Record<string, string>;
}
interface CacheEntry {
  expiresAt: number;
  result: Observable<CachedResult>;
}

/** Include expanded variables, but never store datasource credentials in the key. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function readableError(error: unknown): Error {
  const candidate = error as {
    message?: string;
    name?: string;
    data?: { detail?: unknown; message?: string };
    status?: number;
  };
  if (candidate?.status === 401 || candidate?.status === 403) {
    return new Error(
      'Timestral: Access was denied. Check the service API token and your access to the selected source datasource.'
    );
  }
  if (candidate?.name === 'TimeoutError') {
    return new Error('Timestral: The request timed out. Reduce the number of series or check the inference service.');
  }
  const detail = candidate?.data?.detail;
  const message =
    typeof detail === 'string'
      ? detail
      : candidate?.data?.message || candidate?.message || 'The request failed. Check the source and inference service.';
  return new Error(message.startsWith('Timestral:') ? message : `Timestral: ${message}`);
}

/** Cancellable queue: one datasource instance submits at most four requests at once. */
class RequestQueue {
  private active = 0;
  private waiting: Array<() => void> = [];

  run<T>(factory: () => Observable<T>): Observable<T> {
    return new Observable<T>((subscriber) => {
      let started = false;
      let released = false;
      let inner: { unsubscribe: () => void } | undefined;
      const release = () => {
        if (released) {
          return;
        }
        released = true;
        if (started) {
          this.active--;
        } else {
          this.waiting = this.waiting.filter((entry) => entry !== start);
        }
        this.drain();
      };
      const start = () => {
        if (subscriber.closed) {
          release();
          return;
        }
        started = true;
        this.active++;
        inner = defer(factory).pipe(finalize(release)).subscribe(subscriber);
      };
      if (this.waiting.length >= 64) {
        subscriber.error(
          new Error('Too many queued forecasts. Reduce the number of queries or wait for the current requests.')
        );
        return;
      }
      this.waiting.push(start);
      this.drain();
      return () => {
        inner?.unsubscribe();
        release();
      };
    });
  }

  private drain() {
    while (this.active < 4 && this.waiting.length) {
      this.waiting.shift()!();
    }
  }
}

export class TimestralDataSource extends DataSourceApi<TimestralQuery, TimestralOptions> {
  readonly url: string;
  private readonly serviceUrl?: string;
  private cache = new Map<string, CacheEntry>();
  private queue = new RequestQueue();

  constructor(settings: DataSourceInstanceSettings<TimestralOptions>) {
    super(settings);
    this.url = settings.url || `/api/datasources/proxy/uid/${settings.uid}`;
    this.serviceUrl = settings.jsonData.serviceUrl;
  }

  getDefaultQuery(): Partial<TimestralQuery> {
    return { ...queryDefaults, sourceQuery: { refId: 'source' } };
  }

  query(options: DataQueryRequest<TimestralQuery>): Observable<DataQueryResponse> {
    return defer(() => {
      const targets = options.targets.filter((target) => !target.hide && target.sourceDatasourceUid);
      if (!targets.length) {
        return of({ data: [], state: LoadingState.Done });
      }
      const configurationError = serviceUrlError(this.serviceUrl);
      if (configurationError) {
        throw new Error(`${configurationError} Open the Timestral datasource settings to configure it.`);
      }
      for (const target of targets) {
        const errors = queryErrors(target);
        if (errors.length) {
          throw new Error(`${target.refId}: ${errors.join(' ')}`);
        }
      }
      return forkJoin(targets.map((raw) => this.queryTarget(options, { ...queryDefaults, ...raw }))).pipe(
        map((data) => ({ data: data.flat(), state: LoadingState.Done }))
      );
    }).pipe(catchError((error) => throwError(() => readableError(error))));
  }

  private queryTarget(options: DataQueryRequest<TimestralQuery>, target: TimestralQuery): Observable<DataFrame[]> {
    const step = target.stepSeconds!;
    const horizon = target.predictionLength!;
    const backtestLength = target.backtestLength!;
    const end = Math.floor(Math.min(Date.now(), options.range.to.valueOf()) / 1000 / step) * step;
    const start = end - Math.floor((target.historyHours! * 3600) / step) * step;
    return from(getDataSourceSrv().get(target.sourceDatasourceUid!, options.scopedVars)).pipe(
      switchMap((source) => {
        if (source.uid === this.uid || [PLUGIN_ID, LEGACY_PLUGIN_ID].includes(source.meta.id)) {
          throw new Error(
            'Choose an original metrics datasource; Timestral cannot use itself or another Timestral datasource.'
          );
        }
        if (['-- Mixed --', '-- Dashboard --', '__expr__'].includes(source.uid) || typeof source.query !== 'function') {
          throw new Error(
            'Choose a datasource that returns numeric time series. Mixed, dashboard and expression datasources are not supported.'
          );
        }
        const sourceQuery = {
          ...(target.sourceQuery || {}),
          refId: 'source',
          hide: false,
          datasource: { uid: source.uid, type: source.meta.id },
        };
        const scopedVars = {
          ...options.scopedVars,
          __interval: { text: `${step}s`, value: `${step}s` },
          __interval_ms: { text: String(step * 1000), value: step * 1000 },
          __range: { text: `${end - start}s`, value: `${end - start}s` },
          __range_s: { text: String(end - start), value: end - start },
          __range_ms: { text: String((end - start) * 1000), value: (end - start) * 1000 },
          __from: { text: String(start * 1000), value: start * 1000 },
          __to: { text: String(end * 1000), value: end * 1000 },
        };
        // Explicit text/value pairs avoid serializing Grafana Scenes' cyclic objects.
        const variableValues = Object.fromEntries(
          Object.entries(scopedVars)
            .filter(([key]) => !key.startsWith('__'))
            .map(([key, variable]) => [
              key,
              {
                text: 'text' in variable ? variable.text : undefined,
                value: variable.value,
              },
            ])
        );
        const key = stableStringify({
          source: source.uid,
          expandedSourceQuery: getTemplateSrv().replace(stableStringify(sourceQuery), scopedVars),
          variables: variableValues,
          filters: options.filters,
          start,
          end,
          step,
          horizon,
          backtest: target.backtest,
          backtestLength,
          min: target.min,
          max: target.max,
          unit: target.unit,
          seriesLabel: target.seriesLabel,
        });
        const now = Date.now();
        for (const [existingKey, entry] of this.cache) {
          if (entry.expiresAt < now) {
            this.cache.delete(existingKey);
          }
        }
        let cached = this.cache.get(key);
        if (!cached) {
          if (this.cache.size >= 128) {
            const completed = [...this.cache].find(([, entry]) => Number.isFinite(entry.expiresAt));
            if (completed) {
              this.cache.delete(completed[0]);
            } else {
              throw new Error('Too many concurrent forecast queries. Wait for the current requests to finish.');
            }
          }
          let completed = false;
          const result = this.queue
            .run(() => {
              const range = {
                from: dateTime(start * 1000),
                to: dateTime(end * 1000),
                raw: {
                  from: dateTime(start * 1000),
                  to: dateTime(end * 1000),
                },
              };
              const sourceRequest: DataQueryRequest = {
                ...options,
                requestId: `${options.requestId}-timestral-${target.refId}`,
                targets: [sourceQuery],
                range,
                interval: `${step}s`,
                intervalMs: step * 1000,
                maxDataPoints: Math.floor((end - start) / step) + 1,
                scopedVars,
              };
              const queryResult = source.query(sourceRequest);
              const observable = isObservable(queryResult) ? queryResult : from(queryResult);
              return observable.pipe(
                filter(
                  (response) => response.state !== LoadingState.Loading && response.state !== LoadingState.Streaming
                ),
                take(1),
                timeout({ first: 120000 }),
                throwIfEmpty(() => new Error('The source completed without a numeric time-series result.')),
                switchMap((queried) => {
                  const legacyError = (queried as { error?: { message?: string } }).error;
                  const sourceErrors = queried.errors?.length ? queried.errors : legacyError ? [legacyError] : [];
                  if (sourceErrors.length) {
                    throw new Error(sourceErrors.map((error) => error.message).join('; ') || 'Source query failed.');
                  }
                  const extracted = extractSeries(queried.data as DataFrame[], target, step, start, end);
                  const body: ForecastRequest = {
                    series: extracted.series,
                    step_seconds: step,
                    prediction_length: horizon,
                    backtest: target.backtest!,
                    backtest_length: backtestLength,
                  };
                  return getBackendSrv()
                    .fetch<ForecastResponse>({
                      url: `${this.url}/timestral/forecast`,
                      method: 'POST',
                      data: body,
                      headers: { 'Content-Type': 'application/json' },
                      showErrorAlert: false,
                    })
                    .pipe(
                      take(1),
                      timeout({ first: 120000 }),
                      map((forecast) => ({
                        response: forecast.data,
                        units: extracted.units,
                        labels: extracted.labels,
                      }))
                    );
                })
              );
            })
            .pipe(
              timeout({ first: 120000 }),
              tap({
                next: () => {
                  completed = true;
                  const entry = this.cache.get(key);
                  if (entry?.result === result) {
                    entry.expiresAt = Date.now() + 60000;
                  }
                },
              }),
              finalize(() => {
                if (!completed && this.cache.get(key)?.result === result) {
                  this.cache.delete(key);
                }
              }),
              shareReplay({ bufferSize: 1, refCount: true })
            );
          cached = { expiresAt: Infinity, result };
          this.cache.set(key, cached);
        }
        return cached.result.pipe(
          map((result) =>
            resultFrames(result.response, target, result.units, options.range.from.valueOf(), result.labels)
          )
        );
      })
    );
  }

  async testDatasource() {
    const configurationError = serviceUrlError(this.serviceUrl);
    if (configurationError) {
      return { status: 'error', title: 'Service URL required', message: configurationError };
    }
    try {
      const { data } = await firstValueFrom(
        getBackendSrv()
          .fetch<ServiceStatus>({
            url: `${this.url}/timestral/status`,
            method: 'GET',
            showErrorAlert: false,
          })
          .pipe(timeout({ first: 15000 }))
      );
      if (!data.ready) {
        return {
          status: 'error',
          title: 'Timestral is warming up',
          message:
            'The service is reachable, but the model is not ready. Allow the first download to finish, then try again.',
        };
      }
      return {
        status: 'success',
        title: 'Ready to forecast',
        message: `${data.model} is ready on ${data.device}. Choose an existing metrics datasource in your first query.`,
      };
    } catch (error) {
      return { status: 'error', title: 'Cannot connect to Timestral', message: readableError(error).message };
    }
  }
}
