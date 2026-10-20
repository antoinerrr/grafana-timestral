import { DataSourcePlugin } from '@grafana/data';
import { TimestralDataSource } from './datasource';
import { QueryEditor } from './QueryEditor';
import { ConfigEditor } from './ConfigEditor';
import { TimestralOptions, TimestralQuery, TimestralSecureOptions } from './types';

export const plugin = new DataSourcePlugin<
  TimestralDataSource,
  TimestralQuery,
  TimestralOptions,
  TimestralSecureOptions
>(TimestralDataSource)
  .setQueryEditor(QueryEditor)
  .setConfigEditor(ConfigEditor);
