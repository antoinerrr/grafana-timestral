const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const rxjs = require('rxjs');

// Execute the shipped AMD bundle against Grafana host APIs.
function harness(sourceOverrides = {}, settings = {}) {
  const reads = [];
  const forecasts = [];
  const requests = [];
  let variable = 'first';
  let customFetch;
  const end = 1700000100;
  const start = end - 168 * 3600;
  const timestamps = Array.from({ length: 2017 }, (_, i) => (start + i * 300) * 1000);
  const values = timestamps.map(() => 3);
  values[values.length - 2] = 2;
  values[values.length - 1] = null;
  const source = {
    uid: 'existing-source',
    type: 'generic-metrics',
    meta: { id: 'generic-metrics' },
    query: async (request) => {
      reads.push(request);
      return {
        data: [
          {
            name: 'gauge',
            fields: [
              { name: 'Time', type: 'time', values: [...timestamps, (end - 299) * 1000, (end + 1) * 1000] },
              {
                name: 'value',
                type: 'number',
                config: { unit: 'watt' },
                labels: { instance: 'server' },
                values: [...values, 3, 999],
              },
            ],
          },
        ],
      };
    },
    ...sourceOverrides,
  };
  const forecastResponse = (request) => ({
    data: {
      model: 'mistralai/Timestral-5M',
      revision: 'pinned',
      generated_at: end,
      inference_seconds: 1,
      cache_hit: false,
      series: request.data.series.map((series) => ({
        id: series.id,
        observed: series,
        forecast: { timestamps: [end + 300, end + 600], p10: [2, 3], p50: [4, 5], p90: [6, 7] },
        backtest: request.data.backtest
          ? {
              timestamps: [end - 300],
              actual: [3],
              p10: [2],
              p50: [4],
              p90: [6],
              mae: 1,
              naive_mae: 2,
              interval_coverage: 1,
            }
          : null,
        diagnostics: {
          context_points: series.values.length,
          finite_points: series.values.filter((v) => v !== null).length,
        },
      })),
    },
  });
  class DataSourceApi {
    constructor(instanceSettings) {
      Object.assign(this, instanceSettings);
    }
  }
  class DataSourcePlugin {
    constructor(DataSourceClass) {
      this.DataSourceClass = DataSourceClass;
    }
    setQueryEditor() {
      return this;
    }
    setConfigEditor() {
      return this;
    }
  }
  const host = {
    '@grafana/data': {
      DataSourceApi,
      DataSourcePlugin,
      FieldType: { time: 'time', number: 'number' },
      LoadingState: { Done: 'Done', Loading: 'Loading', Streaming: 'Streaming' },
      dateTime: (ms) => ({ valueOf: () => ms }),
      toDataFrame: (frame) => frame,
    },
    '@grafana/runtime': {
      getTemplateSrv: () => ({ replace: (text) => text.replace('$testVariable', variable) }),
      getDataSourceSrv: () => ({ get: async () => source }),
      getBackendSrv: () => ({
        fetch: (request) => {
          requests.push(request);
          if (request.url.endsWith('/forecast')) {
            forecasts.push(request);
          }
          if (customFetch) {
            return customFetch(request);
          }
          return request.url.endsWith('/status')
            ? rxjs.of({ data: { ready: true, model: 'mistralai/Timestral-5M', device: 'cpu' } })
            : rxjs.of(forecastResponse(request));
        },
      }),
    },
    '@grafana/ui': {},
    react: {},
    rxjs,
    module: { uri: '/public/plugins/antoinerrr-timestral-datasource/module.js' },
  };
  let artifact;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/module.js'), 'utf8'), {
    define: (dependencies, factory) => {
      artifact = factory(...dependencies.map((name) => host[name]));
    },
    Date,
    URL,
    console,
  });
  const datasource = new artifact.plugin.DataSourceClass({
    uid: 'timestral',
    url: '/api/datasources/proxy/uid/timestral',
    jsonData: { serviceUrl: 'http://timestral:8000' },
    ...settings,
  });
  const options = (mode = 'forecast', extra = {}) => ({
    requestId: 'panel',
    range: { from: { valueOf: () => (end - 3600) * 1000 }, to: { valueOf: () => end * 1000 + 90000 } },
    scopedVars: {},
    targets: [
      {
        refId: 'A',
        sourceDatasourceUid: 'existing-source',
        sourceQuery: { expression: 'a configurable query' },
        mode,
        ...extra,
      },
    ],
  });
  return {
    datasource,
    query: (opts) => rxjs.firstValueFrom(datasource.query(opts)),
    options,
    reads,
    forecasts,
    requests,
    source,
    start,
    end,
    timestamps,
    values,
    forecastResponse,
    setVariable: (next) => {
      variable = next;
    },
    setFetch: (fn) => {
      customFetch = fn;
    },
  };
}

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

test('queries a generic source and sends opaque IDs with numeric arrays, excluding future values', async () => {
  const h = harness();
  const result = await h.query(h.options());
  assert.equal(h.reads[0].range.to.valueOf(), h.end * 1000);
  assert.equal(h.reads[0].range.from.valueOf(), h.start * 1000);
  assert.equal(h.reads[0].intervalMs, 300000);
  assert.equal(h.reads[0].targets[0].expression, 'a configurable query');
  const request = JSON.parse(JSON.stringify(h.forecasts[0].data));
  assert.deepEqual(request.series[0].values.slice(-2), [3, null]);
  assert.deepEqual(request.series[0].timestamps.slice(-2), [h.end - 300, h.end]);
  assert.equal(request.series[0].id, 'series-1');
  for (const text of ['a configurable query', 'gauge', 'server', 'instance', 'watt', 'existing-source']) {
    assert.equal(JSON.stringify(request).includes(text), false);
  }
  assert.equal(result.data[0].name, 'gauge {instance=server}');
  assert.equal(result.data[0].fields[1].config.unit, 'watt');
  assert.equal(result.data[1].fields[2].name, 'Forecast p50');
  assert.equal(result.data[1].fields[3].config.custom.fillBelowTo, 'Forecast p10');
});

test('forecast, validation and summary share one concurrent inference and preserve units', async () => {
  const h = harness();
  const [forecast, backtest, summary] = await Promise.all([
    h.query(h.options('forecast')),
    h.query(h.options('backtest')),
    h.query(h.options('summary')),
  ]);
  assert.equal(h.reads.length, 1);
  assert.equal(h.forecasts.length, 1);
  assert.equal(forecast.data.length, 2);
  assert.equal(backtest.data[0].fields[2].name, 'Backtest p10');
  const fields = summary.data[0].fields;
  assert.equal(fields.find((field) => field.name === 'Latest actual').values[0], 3);
  assert.equal(fields.find((field) => field.name === 'Predicted change').values[0], 2);
  assert.equal(fields.find((field) => field.name === 'Backtest interval coverage').config.unit, 'percentunit');
});

test('wide numeric fields and legacy vectors retain distinct local labels', async () => {
  const h = harness();
  h.source.query = async () => ({
    data: [
      {
        name: 'site',
        fields: [
          { name: 'time', type: 'time', values: { length: h.timestamps.length, get: (i) => h.timestamps[i] } },
          { name: 'one', type: 'number', labels: { node: 'a' }, config: {}, values: { toArray: () => h.values } },
          { name: 'two', type: 'number', labels: { node: 'a' }, config: {}, values: h.values },
        ],
      },
    ],
  });
  const result = await h.query(h.options());
  assert.deepEqual(
    Array.from(h.forecasts[0].data.series, (s) => s.id),
    ['series-1', 'series-2']
  );
  assert.equal(result.data[0].name, 'site · one {node=a}');
  assert.equal(result.data[2].name, 'site · two {node=a}');
});

test('recursive Timestral sources, invalid bounds and impossible contexts fail before inference', async () => {
  for (const id of ['mistral-timestral-datasource', 'antoinerrr-timestral-datasource']) {
    const h = harness({ meta: { id } });
    await assert.rejects(h.query(h.options()), /cannot use itself/);
    assert.equal(h.forecasts.length, 0);
  }
  const h = harness();
  for (const [settings, expected] of [
    [{ predictionLength: 2017 }, /1–2016/],
    [{ min: 100, max: 0 }, /lower bound/],
    [{ min: NaN }, /finite numbers/],
    [{ historyHours: 1 }, /64–32,768/],
    [{ historyHours: 100000 }, /64–32,768/],
    [{ historyHours: 8, backtestLength: 72 }, /64 training/],
    [{ stepSeconds: 0 }, /Sample interval/],
    [{ mode: 'backtest', backtest: false }, /Enable historical validation/],
  ]) {
    await assert.rejects(h.query(h.options('forecast', settings)), expected);
  }
  assert.equal(h.reads.length, 0);
});

test('source failures are surfaced and retried instead of cached', async () => {
  let calls = 0;
  const h = harness({
    query: async () => {
      calls++;
      return { data: [], errors: [{ message: 'metric unavailable' }] };
    },
  });
  await assert.rejects(h.query(h.options()), /metric unavailable/);
  await assert.rejects(h.query(h.options()), /metric unavailable/);
  assert.equal(calls, 2);
  assert.equal(h.forecasts.length, 0);
});

test('cache keys track expanded dashboard variables but are independent of query object key order', async () => {
  const h = harness();
  await h.query(h.options('forecast', { sourceQuery: { a: 1, expression: '$testVariable' } }));
  await h.query(h.options('forecast', { sourceQuery: { expression: '$testVariable', a: 1 } }));
  assert.equal(h.reads.length, 1);
  h.setVariable('second');
  await h.query(h.options('forecast', { sourceQuery: { expression: '$testVariable', a: 1 } }));
  assert.equal(h.reads.length, 2);
});

test('display labels and units never travel to the service and remain correct across cache variants', async () => {
  const h = harness();
  const a = await h.query(h.options('forecast', { seriesLabel: 'A private display label', unit: 'celsius' }));
  const b = await h.query(h.options('forecast', { seriesLabel: 'Another label', unit: 'watt' }));
  assert.equal(a.data[0].name, 'A private display label {instance=server}');
  assert.equal(b.data[0].name, 'Another label {instance=server}');
  assert.equal(a.data[0].fields[1].config.unit, 'celsius');
  assert.equal(b.data[0].fields[1].config.unit, 'watt');
  assert.equal(JSON.stringify(h.forecasts).includes('private display'), false);
});

test('stale trailing data and insufficient training coverage fail before calling Python', async () => {
  const h = harness();
  h.source.query = async () => ({
    data: [
      {
        fields: [
          { name: 'time', type: 'time', values: h.timestamps },
          { name: 'value', type: 'number', config: {}, values: h.values.map((v, i) => (i >= 2014 ? null : v)) },
        ],
      },
    ],
  });
  await assert.rejects(h.query(h.options()), /last three samples/);
  h.source.query = async () => ({
    data: [
      {
        fields: [
          { name: 'time', type: 'time', values: h.timestamps },
          { name: 'value', type: 'number', config: {}, values: h.values.map((v, i) => (i < 1000 ? null : v)) },
        ],
      },
    ],
  });
  await assert.rejects(h.query(h.options()), /training history/);
  assert.equal(h.forecasts.length, 0);
});

test('missing samples remain null and unsorted bucket duplicates choose the latest finite value', async () => {
  const h = harness();
  h.source.query = async () => ({
    data: [
      {
        fields: [
          {
            name: 'time',
            type: 'time',
            values: [...h.timestamps.slice(1), (h.end - 298) * 1000, (h.end - 299) * 1000],
          },
          { name: 'value', type: 'number', config: {}, values: [...h.values.slice(1), 5, 4] },
        ],
      },
    ],
  });
  await h.query(h.options());
  const values = h.forecasts[0].data.series[0].values;
  assert.equal(values[0], null);
  assert.equal(values[values.length - 2], 5);
});

test('logs, excessive series and mismatched columns produce actionable source errors', async () => {
  const h = harness({
    query: async () => ({ data: [{ fields: [{ name: 'message', type: 'string', values: ['hello'] }] }] }),
  });
  await assert.rejects(h.query(h.options()), /no numeric time series/);
  h.source.query = async () => ({
    data: [
      {
        fields: [
          { name: 'time', type: 'time', values: h.timestamps },
          ...Array.from({ length: 17 }, (_, i) => ({ name: `${i}`, type: 'number', config: {}, values: h.values })),
        ],
      },
    ],
  });
  await assert.rejects(h.query(h.options()), /more than 16 series/);
  h.source.query = async () => ({
    data: [
      {
        fields: [
          { name: 'time', type: 'time', values: h.timestamps },
          { name: 'value', type: 'number', config: {}, values: [1] },
        ],
      },
    ],
  });
  await assert.rejects(h.query(h.options()), /different lengths/);
  assert.equal(h.forecasts.length, 0);
});

test('at most four unique forecast requests run concurrently', async () => {
  const h = harness();
  const pending = [];
  let active = 0;
  let maximum = 0;
  h.setFetch(
    (request) =>
      new rxjs.Observable((subscriber) => {
        active++;
        maximum = Math.max(maximum, active);
        pending.push(() => {
          subscriber.next(h.forecastResponse(request));
          subscriber.complete();
        });
        return () => {
          active--;
        };
      })
  );
  const requests = Array.from({ length: 11 }, (_, i) =>
    h.query(h.options('forecast', { sourceQuery: { expression: `metric-${i}` } }))
  );
  await nextTick();
  assert.equal(pending.length, 4);
  while (pending.length) {
    pending.shift()();
    await nextTick();
  }
  await Promise.all(requests);
  assert.equal(h.forecasts.length, 11);
  assert.equal(maximum, 4);
});

test('cancelling all subscribers aborts the shared inference and permits retry', async () => {
  const h = harness();
  let cancellations = 0;
  h.setFetch(
    () =>
      new rxjs.Observable(() => () => {
        cancellations++;
      })
  );
  const a = h.datasource.query(h.options()).subscribe();
  const b = h.datasource.query(h.options('summary')).subscribe();
  await nextTick();
  assert.equal(h.forecasts.length, 1);
  a.unsubscribe();
  assert.equal(cancellations, 0);
  b.unsubscribe();
  assert.equal(cancellations, 1);
  h.setFetch(undefined);
  await h.query(h.options());
  assert.equal(h.forecasts.length, 2);
});

test('cancelling queued requests does not fetch their source data', async () => {
  const h = harness();
  h.setFetch(() => new rxjs.Observable(() => undefined));
  const subscriptions = Array.from({ length: 8 }, (_, i) =>
    h.datasource.query(h.options('forecast', { sourceQuery: { expression: `metric-${i}` } })).subscribe()
  );
  await nextTick();
  assert.equal(h.reads.length, 4);
  for (const subscription of subscriptions.slice(4)) {
    subscription.unsubscribe();
  }
  for (const subscription of subscriptions.slice(0, 4)) {
    subscription.unsubscribe();
  }
  await nextTick();
  assert.equal(h.reads.length, 4);
});

test('cancelling an active source Observable unsubscribes it', async () => {
  let cancelled = false;
  const h = harness({
    query: () =>
      new rxjs.Observable(() => () => {
        cancelled = true;
      }),
  });
  const subscription = h.datasource.query(h.options()).subscribe();
  await nextTick();
  subscription.unsubscribe();
  assert.equal(cancelled, true);
  assert.equal(h.forecasts.length, 0);
});

test('service connection testing authenticates through /status and checks model readiness', async () => {
  const h = harness();
  assert.equal((await h.datasource.testDatasource()).status, 'success');
  assert.equal(h.requests[0].url.endsWith('/status'), true);
  h.setFetch(() => rxjs.of({ data: { ready: false } }));
  assert.equal((await h.datasource.testDatasource()).title, 'Timestral is warming up');
  h.setFetch(() => rxjs.throwError(() => ({ status: 401, data: { detail: 'sensitive server echo' } })));
  const result = await h.datasource.testDatasource();
  assert.match(result.message, /API token/);
  assert.equal(result.message.includes('sensitive'), false);
});

test('invalid and credential-bearing service URLs fail without sending requests', async () => {
  for (const serviceUrl of [
    '',
    'localhost:8000',
    'ftp://timestral',
    'http://user:password@timestral',
    'http://timestral?token=secret',
  ]) {
    const h = harness({}, { jsonData: { serviceUrl } });
    assert.equal((await h.datasource.testDatasource()).status, 'error');
    await assert.rejects(h.query(h.options()));
    assert.equal(h.requests.length, 0);
    assert.equal(h.reads.length, 0);
  }
});

test('an empty source Observable returns a useful error', async () => {
  const h = harness({ query: () => rxjs.EMPTY });
  await assert.rejects(h.query(h.options()), /source completed without/);
  assert.equal(h.forecasts.length, 0);
});

test('multi-series forecast and validation bands target the matching lower bound without panel overrides', async () => {
  const h = harness();
  h.source.query = async () => ({
    data: [
      {
        name: 'site',
        fields: [
          { name: 'time', type: 'time', values: h.timestamps },
          { name: 'temperature', type: 'number', config: {}, labels: { room: 'a' }, values: h.values },
          { name: 'power', type: 'number', config: {}, labels: { room: 'b' }, values: h.values },
        ],
      },
    ],
  });
  for (const mode of ['forecast', 'backtest']) {
    const result = await h.query(h.options(mode));
    const bandFrames = result.data.filter((frame) => frame.fields.some((field) => field.name.endsWith('p90')));
    assert.equal(bandFrames.length, 2);
    for (const frame of bandFrames) {
      const lower = frame.fields.find((field) => field.name.endsWith('p10'));
      const median = frame.fields.find((field) => field.name.endsWith('p50'));
      const upper = frame.fields.find((field) => field.name.endsWith('p90'));
      assert.equal(
        upper.config.custom.fillBelowTo,
        `${frame.name} · ${mode === 'forecast' ? 'Forecast' : 'Backtest'} p10`
      );
      assert.equal(upper.config.custom.fillBelowTo, lower.name);
      assert.equal(upper.config.custom.fillOpacity, 16);
      for (const bound of [lower, upper]) {
        assert.equal(bound.config.custom.lineWidth, 0);
        assert.equal(bound.config.custom.hideFrom.legend, true);
      }
      assert.equal(median.config.custom.lineWidth, 2);
      assert.equal(median.config.color.fixedColor, '#FF9830');
    }
  }
});
