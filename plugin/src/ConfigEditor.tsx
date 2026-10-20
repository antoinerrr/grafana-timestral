import React from 'react';
import { DataSourcePluginOptionsEditorProps } from '@grafana/data';
import { Field, Input, SecretInput, useTheme2 } from '@grafana/ui';
import { TimestralOptions, TimestralSecureOptions } from './types';
import { serviceUrlError } from './validation';

type Props = DataSourcePluginOptionsEditorProps<TimestralOptions, TimestralSecureOptions>;

export function ConfigEditor({ options, onOptionsChange }: Props) {
  const theme = useTheme2();
  const value = options.jsonData.serviceUrl || '';
  const error = value ? serviceUrlError(value) : undefined;
  return (
    <div style={{ maxWidth: 800 }}>
      <h3 style={{ fontSize: 16 }}>Inference service</h3>
      <Field
        label="Service URL"
        description="Reachable from the Grafana server. The Compose demo uses http://timestral:8000."
        invalid={!!error}
        error={error}
      >
        <Input
          aria-label="Timestral service URL"
          value={value}
          placeholder="http://timestral:8000"
          onChange={(event) =>
            onOptionsChange({ ...options, jsonData: { ...options.jsonData, serviceUrl: event.currentTarget.value } })
          }
          onBlur={() =>
            onOptionsChange({
              ...options,
              jsonData: { ...options.jsonData, serviceUrl: value.trim().replace(/\/+$/, '') },
            })
          }
        />
      </Field>
      <Field label="API token" description="The service token. Encrypted by Grafana and added to server-side requests.">
        <SecretInput
          aria-label="Timestral API token"
          type="password"
          autoComplete="new-password"
          value={options.secureJsonData?.apiToken || ''}
          isConfigured={!!options.secureJsonFields?.apiToken}
          placeholder="Service API token"
          onChange={(event) =>
            onOptionsChange({
              ...options,
              secureJsonData: { ...options.secureJsonData, apiToken: event.currentTarget.value },
            })
          }
          onReset={() =>
            onOptionsChange({
              ...options,
              secureJsonFields: { ...options.secureJsonFields, apiToken: false },
              secureJsonData: { ...options.secureJsonData, apiToken: '' },
            })
          }
        />
      </Field>
      <div style={{ color: theme.colors.text.secondary, fontSize: 12, lineHeight: 1.7 }}>
        <p>Save &amp; test checks the connection and model readiness. The first startup downloads the model.</p>
        <p>
          Use HTTPS outside a trusted private network. Leave the token empty only when service authentication is
          explicitly disabled.
        </p>
        <p>
          Source queries and labels stay in Grafana. Only numeric series and forecast settings are sent to the service.
        </p>
      </div>
    </div>
  );
}
