import React, { useEffect, useState } from 'react';
import { CoreApp, DataSourceApi, QueryEditorProps } from '@grafana/data';
import type { DataQuery } from '@grafana/schema';
import { DataSourcePicker, getDataSourceSrv } from '@grafana/runtime';
import { Alert, Badge, Button, Field, Input, Combobox, Switch, TextArea, useTheme2 } from '@grafana/ui';
import { TimestralDataSource } from './datasource';
import { LEGACY_PLUGIN_ID, PLUGIN_ID, TimestralOptions, TimestralQuery, queryDefaults } from './types';
import { formatDuration, queryErrors } from './validation';

type Props = QueryEditorProps<TimestralDataSource, TimestralQuery, TimestralOptions>;

export function QueryEditor(props: Props) {
  const { query, onChange, onRunQuery } = props;
  const theme = useTheme2();
  const value = { ...queryDefaults, ...query };
  const [loadedSource, setLoadedSource] = useState<{ uid?: string; source?: DataSourceApi; error?: string }>({});
  const source = loadedSource.uid === query.sourceDatasourceUid ? loadedSource.source : undefined;
  const sourceError = loadedSource.uid === query.sourceDatasourceUid ? loadedSource.error : undefined;
  const [jsonDraft, setJsonDraft] = useState<{ source: TimestralQuery['sourceQuery']; text: string }>();
  const jsonText =
    jsonDraft && jsonDraft.source === query.sourceQuery
      ? jsonDraft.text
      : JSON.stringify(query.sourceQuery || { refId: 'source' }, null, 2);
  const [jsonError, setJsonError] = useState('');
  const errors = queryErrors(query);
  const update = (change: Partial<TimestralQuery>) => onChange({ ...query, ...change });
  const run = () => {
    if (!errors.length && !jsonError) {
      onRunQuery();
    }
  };
  const section: React.CSSProperties = {
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    padding: 16,
    background: theme.colors.background.secondary,
  };
  const row: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 16 };
  const hint: React.CSSProperties = { color: theme.colors.text.secondary, fontSize: 12, lineHeight: 1.6 };
  const heading: React.CSSProperties = { fontSize: 14, fontWeight: 600, margin: '0 0 12px' };

  useEffect(() => {
    let active = true;
    if (query.sourceDatasourceUid) {
      getDataSourceSrv()
        .get(query.sourceDatasourceUid)
        .then((loaded) => {
          if (active) {
            setLoadedSource({ uid: query.sourceDatasourceUid, source: loaded });
          }
        })
        .catch(() => {
          if (active) {
            setLoadedSource({
              uid: query.sourceDatasourceUid,
              error: 'This datasource could not be loaded. Check that it exists and that you have access to it.',
            });
          }
        });
    }
    return () => {
      active = false;
    };
  }, [query.sourceDatasourceUid]);

  const sourceQuery = query.sourceQuery || { refId: 'source' };
  const SourceEditor = source?.components?.QueryEditor;
  const updateSource = (next: DataQuery) => update({ sourceQuery: { ...next, refId: 'source' } });
  const numeric =
    (field: keyof TimestralQuery, optional = false) =>
    (event: React.FormEvent<HTMLInputElement>) => {
      const text = event.currentTarget.value;
      update({ [field]: text === '' ? (optional ? undefined : 0) : Number(text) });
    };
  const points = Math.floor((value.historyHours * 3600) / value.stepSeconds) + 1;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 4 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingBottom: 4 }}>
        <Badge color="blue" text={`${formatDuration(value.historyHours * 3600)} history`} />
        <Badge color="darkgrey" text={`${formatDuration(value.stepSeconds)} samples`} />
        <Badge color="orange" text={`${formatDuration(value.predictionLength * value.stepSeconds)} ahead`} />
      </div>

      <section style={section} aria-label="Source">
        <h3 style={heading}>Source</h3>
        <Field label="Source datasource" description="Uses your existing datasource and access permissions.">
          <DataSourcePicker
            current={query.sourceDatasourceUid || null}
            noDefault
            metrics
            variables
            filter={(candidate) =>
              ![PLUGIN_ID, LEGACY_PLUGIN_ID].includes(candidate.type) &&
              !['-- Mixed --', '-- Dashboard --', '__expr__'].includes(candidate.uid)
            }
            onChange={async (selected) => {
              try {
                const loaded = await getDataSourceSrv().get(selected.uid);
                const defaults = loaded.getDefaultQuery?.(props.app || CoreApp.PanelEditor) || {};
                onChange({
                  ...query,
                  sourceDatasourceUid: selected.uid,
                  sourceQuery: {
                    ...defaults,
                    refId: 'source',
                    ...(loaded.type === 'prometheus' ? { range: true, instant: false, editorMode: 'code' } : {}),
                  },
                });
              } catch {
                setLoadedSource({
                  uid: query.sourceDatasourceUid,
                  error: 'Could not load that datasource. Check your access and try again.',
                });
              }
            }}
          />
        </Field>
        {sourceError && (
          <Alert severity="error" title="Source unavailable">
            {sourceError}
          </Alert>
        )}
        {source && SourceEditor && (
          <div style={{ paddingTop: 8 }}>
            <SourceEditor
              datasource={source}
              query={sourceQuery}
              onChange={updateSource}
              onRunQuery={run}
              range={props.range}
              app={props.app}
              queries={[sourceQuery]}
            />
          </div>
        )}
        {source && !SourceEditor && (
          <div style={hint}>
            This datasource has no embedded editor. Configure its query in Advanced → Source query JSON below.
          </div>
        )}
        {!query.sourceDatasourceUid && (
          <div style={hint}>
            Works with numeric time series such as temperature, traffic, energy use or storage growth.
          </div>
        )}
      </section>

      <section style={section} aria-label="Forecast">
        <h3 style={heading}>Forecast</h3>
        <div style={row}>
          <Field
            label="Forecast ahead"
            description={`${value.predictionLength} steps × ${formatDuration(value.stepSeconds)} per sample`}
          >
            <div
              role="group"
              aria-label="Forecast duration presets"
              style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}
            >
              {[1, 2, 6, 24].map((hours) => {
                const steps = Math.round((hours * 3600) / value.stepSeconds);
                const active = value.predictionLength === steps;
                return (
                  <Button
                    key={hours}
                    type="button"
                    size="md"
                    variant={active ? 'primary' : 'secondary'}
                    aria-pressed={active}
                    disabled={steps < 1 || steps > 2016}
                    onClick={() => update({ predictionLength: steps, backtestLength: steps })}
                  >
                    {hours}h
                  </Button>
                );
              })}
            </div>
          </Field>
          <Field label="Show in the panel" htmlFor={`timestral-output-${query.refId}`}>
            <Combobox
              width={30}
              id={`timestral-output-${query.refId}`}
              value={value.mode}
              options={[
                { value: 'forecast', label: 'Actual + forecast' },
                { value: 'backtest', label: 'Historical validation' },
                { value: 'summary', label: 'Summary statistics' },
              ]}
              onChange={(option) =>
                update({
                  mode: option.value as TimestralQuery['mode'],
                  ...(option.value === 'backtest' ? { backtest: true } : {}),
                })
              }
            />
          </Field>
        </div>
        <div style={hint}>
          Median prediction with a p10–p90 band. Set the dashboard range end to{' '}
          <code>now+{formatDuration(value.predictionLength * value.stepSeconds)}</code> to see the full outlook.
        </div>
        <div
          style={{
            ...row,
            alignItems: 'center',
            justifyContent: 'space-between',
            borderTop: `1px solid ${theme.colors.border.weak}`,
            paddingTop: 12,
            marginTop: 12,
          }}
        >
          <div>
            <div style={{ fontWeight: 500 }}>Historical validation</div>
            <div style={hint}>
              Test on the last {formatDuration(value.backtestLength * value.stepSeconds)} and compare with a last-value
              baseline.
            </div>
          </div>
          <Switch
            id={`timestral-validation-${query.refId}`}
            aria-label="Enable historical validation"
            value={value.backtest}
            onChange={(event) =>
              update({
                backtest: event.currentTarget.checked,
                ...(!event.currentTarget.checked && value.mode === 'backtest' ? { mode: 'forecast' as const } : {}),
              })
            }
          />
        </div>
      </section>

      <details style={section} open={(!!source && !SourceEditor) || undefined}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Advanced · history, sampling and display</summary>
        <div style={{ ...row, marginTop: 16 }}>
          <Field label="History (hours)" description="Independent of the visible panel range">
            <Input
              aria-label="History in hours"
              width={24}
              type="number"
              min={0.01}
              step="any"
              value={value.historyHours}
              onChange={numeric('historyHours')}
              onBlur={run}
            />
          </Field>
          <Field label="Sample interval (seconds)">
            <Input
              aria-label="Sample interval in seconds"
              width={24}
              type="number"
              min={1}
              max={86400}
              value={value.stepSeconds}
              onChange={numeric('stepSeconds')}
              onBlur={run}
            />
          </Field>
          <Field label="Forecast (steps)">
            <Input
              aria-label="Forecast steps"
              width={20}
              type="number"
              min={1}
              max={2016}
              value={value.predictionLength}
              onChange={numeric('predictionLength')}
              onBlur={run}
            />
          </Field>
          {value.backtest && (
            <Field label="Holdout (steps)">
              <Input
                aria-label="Holdout steps"
                width={20}
                type="number"
                min={1}
                max={2016}
                value={value.backtestLength}
                onChange={numeric('backtestLength')}
                onBlur={run}
              />
            </Field>
          )}
        </div>
        <p style={hint}>
          {Number.isFinite(points) ? points.toLocaleString('en-US') : '—'} history samples requested. Use a regular
          gauge or rate with at least 64 samples and 50% coverage. Convert cumulative counters to rates in the source
          query.
        </p>
        <div style={row}>
          <Field label="Minimum" description="Optional physical bound">
            <Input
              aria-label="Minimum value"
              width={20}
              type="number"
              step="any"
              value={value.min ?? ''}
              placeholder="Unbounded"
              onChange={numeric('min', true)}
              onBlur={run}
            />
          </Field>
          <Field label="Maximum" description="Optional physical bound">
            <Input
              aria-label="Maximum value"
              width={20}
              type="number"
              step="any"
              value={value.max ?? ''}
              placeholder="Unbounded"
              onChange={numeric('max', true)}
              onBlur={run}
            />
          </Field>
          <Field label="Unit" description="Grafana unit ID; inherits the source">
            <Input
              aria-label="Unit"
              width={28}
              value={value.unit || ''}
              placeholder="e.g. celsius, watt, percent"
              onChange={(event) => update({ unit: event.currentTarget.value })}
              onBlur={run}
            />
          </Field>
          <Field label="Display label" description="Optional series name">
            <Input
              aria-label="Display label"
              width={28}
              value={value.seriesLabel || ''}
              placeholder="Use source name"
              onChange={(event) => update({ seriesLabel: event.currentTarget.value })}
              onBlur={run}
            />
          </Field>
        </div>
        {source && (
          <details open={!SourceEditor || undefined}>
            <summary style={{ cursor: 'pointer', margin: '8px 0' }}>Source query JSON</summary>
            <Field
              description="Paste a query object from the source datasource or an existing panel."
              invalid={!!jsonError}
              error={jsonError}
            >
              <TextArea
                aria-label="Source query JSON"
                rows={7}
                value={jsonText}
                style={{ fontFamily: 'monospace' }}
                onChange={(event) => {
                  setJsonDraft({ source: query.sourceQuery, text: event.currentTarget.value });
                  setJsonError('');
                }}
                onBlur={() => {
                  try {
                    const parsed = JSON.parse(jsonText);
                    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                      throw new Error();
                    }
                    updateSource(parsed);
                    setJsonError('');
                  } catch {
                    setJsonError('Enter a valid JSON query object.');
                  }
                }}
              />
            </Field>
          </details>
        )}
      </details>
      {errors.length > 0 && (
        <Alert severity="warning" title="Adjust these settings before running">
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </Alert>
      )}
    </div>
  );
}
