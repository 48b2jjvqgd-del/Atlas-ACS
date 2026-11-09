import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

/**
 * OpenTelemetry tracing — opt-in.
 *
 * Tracing starts only when OTEL_EXPORTER_OTLP_ENDPOINT is configured, so that local runs and
 * tests have no hidden network dependency. Locally, Docker Compose runs Jaeger as the OTLP
 * receiver and trace UI; any OTLP-compatible collector can be supplied instead.
 *
 * Instrumented: inbound and outbound HTTP (node:http and fetch/undici), PostgreSQL queries, and —
 * through injectTraceContext / runWithTraceContext — RabbitMQ events, including events that pass
 * through a transactional outbox. Must be started before the HTTP server module is loaded
 * (see startTracingFromEnvironment and each service's index.ts).
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

let active: TracingHandle | undefined;

export function startTracing(settings: TracingSettings): TracingHandle | undefined {
  if (!settings.otlpEndpoint) return undefined;
  if (active) return active;

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
      new UndiciInstrumentation({
        ignoreRequestHook: (request) => /\/(health|metrics)/.test(request.path),
      }),
      // Statement text only (parameter values are never recorded).
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
    ],
  });
  sdk.start();
  active = { shutdown: () => sdk.shutdown() };
  return active;
}

/**
 * Starts tracing from process environment variables before any instrumented module is loaded.
 * Service entry points call this first and only then import the service (dynamic import).
 */
export function startTracingFromEnvironment(
  service: string,
  version: string,
): TracingHandle | undefined {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  return startTracing({
    service,
    version,
    environment: process.env.ATLAS_ENV ?? 'development',
    otlpEndpoint: endpoint && endpoint.length > 0 ? endpoint : undefined,
  });
}

/** W3C trace context of the active span, for message headers or an outbox row. */
export function injectTraceContext(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/**
 * Runs `work` in a span that continues the trace carried by `carrier` (message headers).
 * Errors are recorded on the span and rethrown.
 */
export async function runWithTraceContext<T>(
  carrier: Record<string, unknown> | undefined,
  spanName: string,
  attributes: Attributes,
  work: () => Promise<T>,
  kind: 'consumer' | 'producer' | 'internal' = 'consumer',
): Promise<T> {
  const strings: Record<string, string> = {};
  for (const [key, value] of Object.entries(carrier ?? {})) {
    if (typeof value === 'string') strings[key] = value;
    else if (Buffer.isBuffer(value)) strings[key] = value.toString('utf8');
  }
  const parent = propagation.extract(context.active(), strings);
  const tracer = trace.getTracer('atlas');
  const spanKind =
    kind === 'consumer'
      ? SpanKind.CONSUMER
      : kind === 'producer'
        ? SpanKind.PRODUCER
        : SpanKind.INTERNAL;
  return tracer.startActiveSpan(spanName, { kind: spanKind, attributes }, parent, async (span) => {
    try {
      return await work();
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Adds attributes (e.g. atlas.correlation_id) to the active span, if any. */
export function annotateActiveSpan(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes);
}
