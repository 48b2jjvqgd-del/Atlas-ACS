import { describe, expect, it } from 'vitest';
import { signedIn, unique } from './client.js';

/** One user action must be visible as one trace across gateway, services and the event consumer. */
const JAEGER = process.env.SYSTEM_TEST_JAEGER_URL ?? 'http://localhost:16686';

interface Span {
  traceId: string;
  name: string;
  attributes?: { key: string; value: { stringValue?: string } }[];
}

async function spansFor(
  service: string,
  sinceMs: number,
): Promise<{ service: string; span: Span }[]> {
  const params = new URLSearchParams({
    'query.service_name': service,
    'query.start_time_min': new Date(sinceMs - 5_000).toISOString(),
    'query.start_time_max': new Date(Date.now() + 5_000).toISOString(),
    'query.search_depth': '100',
  });
  const response = await fetch(`${JAEGER}/api/v3/traces?${params}`);
  if (!response.ok) return [];
  const body = (await response.json()) as {
    result: {
      resourceSpans: {
        resource: { attributes: { key: string; value: { stringValue: string } }[] };
        scopeSpans: { spans: Span[] }[];
      }[];
    };
  };
  return body.result.resourceSpans.flatMap((rs) => {
    const name =
      rs.resource.attributes.find((a) => a.key === 'service.name')?.value.stringValue ?? '?';
    return rs.scopeSpans.flatMap((ss) => ss.spans.map((span) => ({ service: name, span })));
  });
}

describe('distributed tracing', () => {
  it('follows an issuer creation from the gateway through issuer-service and the audit consumer', async () => {
    const started = Date.now();
    const admin = await signedIn('platform.admin@atlas.test');
    const created = await admin.api('POST', '/v1/tenants', {
      slug: unique('traced'),
      displayName: 'Traced Synthetic Issuer',
      internalReference: `TR-${Date.now().toString(36).toUpperCase()}`,
    });
    expect(created.status).toBe(201);
    const correlationId = created.headers.get('x-correlation-id')!;

    let services = new Set<string>();
    for (
      let attempt = 0;
      attempt < 40 && !(services.has('audit-service') && services.has('identity-service'));
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const gatewaySpans = await spansFor('api-gateway', started);
      const root = gatewaySpans.find(({ span }) =>
        span.attributes?.some(
          (a) => a.key === 'atlas.correlation_id' && a.value.stringValue === correlationId,
        ),
      );
      if (!root) continue;
      const all = [
        ...gatewaySpans,
        ...(await spansFor('issuer-service', started)),
        ...(await spansFor('identity-service', started)),
        ...(await spansFor('audit-service', started)),
      ].filter(({ span }) => span.traceId === root.span.traceId);
      services = new Set(all.map(({ service }) => service));
      if (services.has('audit-service')) {
        expect(
          all.some(
            ({ service, span }) => service === 'audit-service' && span.name.endsWith(' process'),
          ),
        ).toBe(true);
      }
    }
    expect([...services].sort()).toEqual([
      'api-gateway',
      'audit-service',
      'identity-service',
      'issuer-service',
    ]);
  });
});
