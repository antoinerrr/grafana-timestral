import { DataSourceJsonData } from '@grafana/data';
import type { DataQuery } from '@grafana/schema';

export const PLUGIN_ID = 'antoinerrr-timestral-datasource';
export const LEGACY_PLUGIN_ID = 'mistral-timestral-datasource';

export interface TimestralQuery extends DataQuery {
  sourceDatasourceUid?: string;
  sourceQuery?: DataQuery & Record<string, unknown>;
  historyHours?: number;
  stepSeconds?: number;
  predictionLength?: number;
  backtest?: boolean;
  backtestLength?: number;
  mode?: 'forecast' | 'summary' | 'backtest';
  min?: number;
  max?: number;
  unit?: string;
  seriesLabel?: string;
}

export interface TimestralOptions extends DataSourceJsonData {
  serviceUrl?: string;
}

export interface TimestralSecureOptions {
  apiToken?: string;
}

export const queryDefaults = {
  historyHours: 168,
  stepSeconds: 300,
  predictionLength: 72,
  backtest: true,
  backtestLength: 72,
  mode: 'forecast' as const,
};

export interface InputSeries {
  id: string;
  timestamps: number[];
  values: Array<number | null>;
  min?: number;
  max?: number;
}

export interface ForecastRequest {
  series: InputSeries[];
  step_seconds: number;
  prediction_length: number;
  backtest: boolean;
  backtest_length: number;
}

export interface ForecastSeries {
  id: string;
  observed: { timestamps: number[]; values: Array<number | null> };
  forecast: { timestamps: number[]; p10: number[]; p50: number[]; p90: number[] };
  backtest: null | {
    training_end_timestamp: number;
    timestamps: number[];
    actual: Array<number | null>;
    p10: number[];
    p50: number[];
    p90: number[];
    mae: number | null;
    naive_mae: number | null;
    interval_coverage: number | null;
    valid_points: number;
  };
  diagnostics: { context_points: number; finite_points: number; missing_fraction?: number };
}

export interface ForecastResponse {
  model: string;
  revision: string;
  generated_at: number;
  cache_hit: boolean;
  inference_seconds: number;
  series: ForecastSeries[];
}

export interface ServiceStatus {
  ready: boolean;
  loading: boolean;
  model: string;
  revision: string;
  device: string;
}
