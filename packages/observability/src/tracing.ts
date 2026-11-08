import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

/**
 * OpenTelemetry tracing — opt-in.
 *
 * Tracing starts only when OTEL_EXPORTER_OTLP_ENDPOINT is configured, so that local runs and
 * tests have no hidden network dependency. Stage 0 ships no trace backend; any OTLP-compatible
 * collector can be supplied. Must be started before the HTTP server module is loaded.
 */
export interface TracingSettings {
  service: string;
  version: string;
  environment: string;
  otlpEndpoint: string | undefined;
}

export interface TracingHandle {
  shutdown(): Promise<void>;
}

export function startTracing(settings: TracingSettings): TracingHandle | undefined {
  if (!settings.otlpEndpoint) return undefined;

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: settings.service,
      [ATTR_SERVICE_VERSION]: settings.version,
      'deployment.environment.name': settings.environment,
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${settings.otlpEndpoint.replace(/\/$/, '')}/v1/traces`,
    }),
    instrumentations: [
      new HttpInstrumentation({
        // Health probes and scrapes would otherwise dominate trace volume.
        ignoreIncomingRequestHook: (request) => /^\/(health|metrics)/.test(request.url ?? ''),
      }),
    ],
  });
  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}
