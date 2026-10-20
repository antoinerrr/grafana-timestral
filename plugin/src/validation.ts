import { TimestralQuery, queryDefaults } from './types';

export const limits = { context: 32768, horizon: 2016, series: 16, minimumContext: 64, minimumFinite: 48 };

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '—';
  }
  const units: Array<[number, string]> = [
    [86400, 'd'],
    [3600, 'h'],
    [60, 'm'],
  ];
  for (const [size, unit] of units) {
    if (seconds >= size && seconds % size === 0) {
      return `${seconds / size}${unit}`;
    }
  }
  if (seconds >= 3600) {
    return `${Number((seconds / 3600).toFixed(1))}h`;
  }
  if (seconds >= 60) {
    return `${Number((seconds / 60).toFixed(1))}m`;
  }
  return `${seconds}s`;
}

/** Shared by the editor and datasource so invalid settings never start a source query. */
export function queryErrors(query: TimestralQuery): string[] {
  const value = { ...queryDefaults, ...query };
  const errors: string[] = [];
  if (!Number.isInteger(value.stepSeconds) || value.stepSeconds < 1 || value.stepSeconds > 86400) {
    errors.push('Sample interval must be an integer from 1 to 86,400 seconds.');
  }
  if (!Number.isFinite(value.historyHours) || value.historyHours <= 0) {
    errors.push('History must be a positive number of hours.');
  }
  if (
    !Number.isInteger(value.predictionLength) ||
    value.predictionLength < 1 ||
    value.predictionLength > limits.horizon
  ) {
    errors.push('Forecast length must be 1–2016 whole steps.');
  }
  if (!Number.isInteger(value.backtestLength) || value.backtestLength < 1 || value.backtestLength > limits.horizon) {
    errors.push('Holdout length must be 1–2016 whole steps.');
  }
  if (typeof value.backtest !== 'boolean') {
    errors.push('Historical validation must be enabled or disabled.');
  }
  if (!['forecast', 'summary', 'backtest'].includes(value.mode)) {
    errors.push('Choose a supported output mode.');
  }
  if (value.mode === 'backtest' && !value.backtest) {
    errors.push('Enable historical validation to show the holdout chart.');
  }
  const points = Math.floor((value.historyHours * 3600) / value.stepSeconds) + 1;
  if (Number.isFinite(points) && (points < limits.minimumContext || points > limits.context)) {
    errors.push(`History must contain 64–32,768 samples; these settings request ${points.toLocaleString('en-US')}.`);
  }
  if (value.backtest && Number.isFinite(points) && points - value.backtestLength < limits.minimumContext) {
    errors.push('Keep at least 64 training samples before the holdout. Increase history or shorten the holdout.');
  }
  if (
    (value.min !== undefined && !Number.isFinite(value.min)) ||
    (value.max !== undefined && !Number.isFinite(value.max))
  ) {
    errors.push('Physical bounds must be finite numbers or left empty.');
  }
  if (value.min !== undefined && value.max !== undefined && value.min >= value.max) {
    errors.push('The lower bound must be below the upper bound.');
  }
  return errors;
}

export function serviceUrlError(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return 'Enter the URL of your Timestral inference service.';
  }
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return 'Use an HTTP or HTTPS URL.';
    }
    if (url.username || url.password || url.search || url.hash) {
      return 'Use a service URL without credentials, query parameters or a fragment. Store the token in the API token field.';
    }
  } catch {
    return 'Enter a valid, absolute HTTP or HTTPS URL.';
  }
  return undefined;
}
