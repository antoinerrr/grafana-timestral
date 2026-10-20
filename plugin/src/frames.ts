import { DataFrame, Field, FieldType, toDataFrame } from '@grafana/data';
import { ForecastResponse, InputSeries, TimestralQuery } from './types';
import { limits } from './validation';

function vectorArray<T>(values: unknown): T[] {
  if (Array.isArray(values)) {
    return values;
  }
  const vector = values as { toArray?: () => T[]; get?: (index: number) => T; length?: number };
  if (vector?.toArray) {
    return vector.toArray();
  }
  if (vector?.get && typeof vector.length === 'number') {
    return Array.from({ length: vector.length }, (_, index) => vector.get!(index));
  }
  return Array.from((values ?? []) as ArrayLike<T>);
}

/** Keep labels in Grafana and normalize numeric series onto the requested grid. */
export function extractSeries(
  frames: DataFrame[],
  target: TimestralQuery,
  step: number,
  start: number,
  end: number
): { series: InputSeries[]; units: Record<string, string | undefined>; labels: Record<string, string> } {
  const series: InputSeries[] = [];
  const units: Record<string, string | undefined> = {};
  const labels: Record<string, string> = {};
  for (const frame of frames) {
    const time = frame.fields.find((field) => field.type === FieldType.time);
    if (!time) {
      continue;
    }
    const times = vectorArray<number>(time.values);
    const numericFields = frame.fields.filter((field) => field.type === FieldType.number);
    for (const field of numericFields) {
      const values = vectorArray<number | null>(field.values);
      if (values.length !== times.length) {
        throw new Error(
          'The source returned time and value columns of different lengths. Select a numeric time-series query.'
        );
      }
      const sourceLabels = field.labels
        ? Object.entries(field.labels)
            .sort()
            .map(([key, value]) => `${key}=${value}`)
            .join(', ')
        : '';
      const baseName =
        target.seriesLabel ||
        field.config.displayNameFromDS ||
        (numericFields.length > 1 ? `${frame.name ? `${frame.name} · ` : ''}${field.name}` : frame.name || field.name);
      const candidate = `${baseName}${sourceLabels ? ` {${sourceLabels}}` : ''}`;
      let displayName = candidate;
      for (let suffix = 2; Object.values(labels).includes(displayName); suffix++) {
        displayName = `${candidate} [${suffix}]`;
      }
      const buckets = new Map<number, { value: number | null; timestamp: number }>();
      times.forEach((timeMs, index) => {
        const originalTimestamp = Number(timeMs) / 1000;
        const ts = Math.floor(originalTimestamp / step) * step;
        if (!Number.isFinite(ts) || originalTimestamp < start || originalTimestamp > end || ts < start || ts > end) {
          return;
        }
        const value = values[index];
        const previous = buckets.get(ts);
        // Choose the latest finite sample even if the source frame is unsorted.
        if (typeof value === 'number' && Number.isFinite(value)) {
          if (Math.abs(value) > 1e30) {
            throw new Error('Source values must have an absolute value no greater than 1e30.');
          }
          if (!previous || previous.value === null || originalTimestamp >= previous.timestamp) {
            buckets.set(ts, { value, timestamp: originalTimestamp });
          }
        } else if (!previous) {
          buckets.set(ts, { value: null, timestamp: originalTimestamp });
        }
      });
      if (!buckets.size) {
        continue;
      }
      if (series.length >= limits.series) {
        throw new Error(
          'The source returned more than 16 series. Filter or aggregate the source query before forecasting.'
        );
      }
      const timestamps = Array.from(
        { length: Math.floor((end - start) / step) + 1 },
        (_, index) => start + index * step
      );
      const observations = timestamps.map((ts) => buckets.get(ts)?.value ?? null);
      const finite = observations.filter((value) => value !== null).length;
      if (
        observations.length < limits.minimumContext ||
        finite < limits.minimumFinite ||
        finite / observations.length < 0.5
      ) {
        throw new Error(
          `${displayName}: need at least 64 sample slots, 48 finite observations and 50% coverage. Choose a longer-lived series or adjust the history and sample interval.`
        );
      }
      if (observations.slice(-3).every((value) => value === null)) {
        throw new Error(
          `${displayName}: the last three samples are missing. Check that the source is still reporting, or use a historical range end.`
        );
      }
      if (target.backtest) {
        const training = observations.slice(0, -target.backtestLength!);
        const trainingFinite = training.filter((value) => value !== null).length;
        if (
          training.length < limits.minimumContext ||
          trainingFinite < limits.minimumFinite ||
          trainingFinite / training.length < 0.5
        ) {
          throw new Error(
            `${displayName}: the training history before the holdout needs 64 sample slots, 48 finite observations and 50% coverage. Add history or shorten the holdout.`
          );
        }
      }
      const id = `series-${series.length + 1}`;
      series.push({
        id,
        timestamps,
        values: observations,
        ...(target.min !== undefined ? { min: target.min } : {}),
        ...(target.max !== undefined ? { max: target.max } : {}),
      });
      units[id] = target.unit || field.config.unit;
      labels[id] = displayName;
    }
  }
  if (!series.length) {
    throw new Error(
      'The source query returned no numeric time series. Use a range query with a time field and numeric value fields; logs, traces, instant queries and string-only tables cannot be forecast.'
    );
  }
  return { series, units, labels };
}

function numberField(name: string, values: Array<number | null>, unit?: string, color?: string): Partial<Field> {
  const lower = name.endsWith('p10');
  const upper = name.endsWith('p90');
  const custom =
    lower || upper
      ? {
          lineWidth: 1,
          lineStyle: { fill: 'dash', dash: [4, 4] },
          fillOpacity: upper ? 24 : 0,
          ...(upper ? { fillBelowTo: name.replace(/p90$/, 'p10') } : {}),
          hideFrom: { legend: false },
        }
      : { lineWidth: 2 };
  return {
    name,
    type: FieldType.number,
    values,
    config: {
      unit,
      custom,
      ...(color ? { color: { mode: 'fixed', fixedColor: color } } : {}),
    },
  };
}

export function resultFrames(
  response: ForecastResponse,
  target: TimestralQuery,
  units: Record<string, string | undefined>,
  visibleFromMs: number,
  labels: Record<string, string> = {}
): DataFrame[] {
  return response.series.flatMap((series) => {
    const unit = target.unit || units[series.id];
    const label = labels[series.id] || series.id;
    const prefix = response.series.length > 1 ? `${label} · ` : '';
    const meta = {
      preferredVisualisationType: 'graph' as const,
      custom: {
        model: response.model,
        revision: response.revision,
        generatedAt: response.generated_at,
        cacheHit: response.cache_hit,
        inferenceSeconds: response.inference_seconds,
        diagnostics: series.diagnostics,
      },
    };
    if (target.mode === 'summary') {
      const finiteObserved = series.observed.values.filter(
        (value): value is number => typeof value === 'number' && Number.isFinite(value)
      );
      const latest = finiteObserved[finiteObserved.length - 1] ?? null;
      const median = series.forecast.p50;
      const end = median[median.length - 1] ?? null;
      const peak = median.length ? Math.max(...median) : null;
      const peakP90 = series.forecast.p90.length ? Math.max(...series.forecast.p90) : null;
      const change = end !== null && latest !== null ? end - latest : null;
      const changePercent =
        change !== null && latest !== null && latest !== 0 ? (100 * change) / Math.abs(latest) : null;
      return [
        toDataFrame({
          name: label,
          refId: target.refId,
          meta: { ...meta, preferredVisualisationType: 'table' },
          fields: [
            numberField(`${prefix}Latest actual`, [latest], unit),
            numberField(`${prefix}Forecast end p50`, [end], unit),
            numberField(`${prefix}Forecast peak p50`, [peak], unit),
            numberField(`${prefix}Forecast peak p90`, [peakP90], unit),
            numberField(`${prefix}Predicted change`, [change], unit),
            numberField(`${prefix}Predicted change %`, [changePercent], 'percent'),
            numberField(`${prefix}Backtest MAE`, [series.backtest?.mae ?? null], unit),
            numberField(`${prefix}Naive MAE`, [series.backtest?.naive_mae ?? null], unit),
            numberField(
              `${prefix}Backtest interval coverage`,
              [series.backtest?.interval_coverage ?? null],
              'percentunit'
            ),
          ],
        }),
      ];
    }
    if (target.mode === 'backtest') {
      const backtest = series.backtest;
      if (!backtest) {
        return [];
      }
      return [
        toDataFrame({
          name: label,
          refId: target.refId,
          meta,
          fields: [
            { name: 'Time', type: FieldType.time, values: backtest.timestamps.map((ts) => ts * 1000) },
            numberField(`${prefix}Actual`, backtest.actual, unit, '#73BF69'),
            numberField(`${prefix}Backtest p10`, backtest.p10, unit, '#5794F2'),
            numberField(`${prefix}Backtest p50`, backtest.p50, unit, '#FF9830'),
            numberField(`${prefix}Backtest p90`, backtest.p90, unit, '#5794F2'),
          ],
        }),
      ];
    }
    const visibleObserved = series.observed.timestamps
      .map((ts, index) => ({ ts, value: series.observed.values[index] }))
      .filter(({ ts }) => ts * 1000 >= visibleFromMs);
    return [
      toDataFrame({
        name: label,
        refId: target.refId,
        meta,
        fields: [
          { name: 'Time', type: FieldType.time, values: visibleObserved.map(({ ts }) => ts * 1000) },
          numberField(
            `${prefix}Actual`,
            visibleObserved.map(({ value }) => value),
            unit,
            '#73BF69'
          ),
        ],
      }),
      toDataFrame({
        name: label,
        refId: target.refId,
        meta,
        fields: [
          { name: 'Time', type: FieldType.time, values: series.forecast.timestamps.map((ts) => ts * 1000) },
          numberField(`${prefix}Forecast p10`, series.forecast.p10, unit, '#5794F2'),
          numberField(`${prefix}Forecast p50`, series.forecast.p50, unit, '#FF9830'),
          numberField(`${prefix}Forecast p90`, series.forecast.p90, unit, '#5794F2'),
        ],
      }),
    ];
  });
}
