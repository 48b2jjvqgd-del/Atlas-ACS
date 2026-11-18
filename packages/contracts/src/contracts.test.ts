import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  configurationChangedV1,
  eventContracts,
  exportJsonSchemas,
  isServiceName,
  parseEvent,
  platformServicesResponseSchema,
  problemDetailsSchema,
  problemTypeFor,
  readinessResponseSchema,
  serviceCatalog,
  tenantCreatedV1,
  type EventEnvelope,
} from './index.js';

function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    specversion: '1.0',
    id: randomUUID(),
    source: 'urn:atlas:service:issuer-service',
    type: tenantCreatedV1.type,
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    dataschema: tenantCreatedV1.schemaUri,
    correlationid: randomUUID(),
    data: { tenantId: randomUUID(), slug: 'synthetic-bank', displayName: 'Synthetic Bank' },
    ...overrides,
  };
}

describe('service catalogue', () => {
  it('assigns every service a unique local port', () => {
    const ports = Object.values(serviceCatalog).map((entry) => entry.port);
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('never assigns two services the same database schema (no shared writes)', () => {
    const schemas = Object.values(serviceCatalog)
      .map((entry) => entry.dataStores.postgresSchema)
      .filter((schema) => schema !== null);
    expect(new Set(schemas).size).toBe(schemas.length);
  });

  it('keeps scheme adapters free of persistent state owned outside ACS Core', () => {
    expect(serviceCatalog['visa-adapter'].dataStores.postgresSchema).toBeNull();
    expect(serviceCatalog['mastercard-adapter'].dataStores.postgresSchema).toBeNull();
  });

  it('identifies known service names', () => {
    expect(isServiceName('acs-core')).toBe(true);
    expect(isServiceName('toString')).toBe(false);
  });
});

describe('event contracts', () => {
  it('parses a valid tenant-created event', () => {
    const event = parseEvent(tenantCreatedV1, envelope());
    expect(event.data.slug).toBe('synthetic-bank');
  });

  it('rejects an envelope missing the correlation ID', () => {
    const { correlationid: _omit, ...withoutCorrelation } = envelope();
    expect(() => parseEvent(tenantCreatedV1, withoutCorrelation)).toThrow();
  });

  it('rejects a payload that violates the data schema', () => {
    const raw = envelope({ data: { tenantId: 'not-a-uuid', slug: 'x', displayName: '' } });
    expect(() => parseEvent(tenantCreatedV1, raw)).toThrow();
  });

  it('rejects an event whose type does not match the contract', () => {
    const raw = envelope({ type: configurationChangedV1.type });
    expect(() => parseEvent(tenantCreatedV1, raw)).toThrow(/type mismatch/);
  });

  it('declares unique, versioned event types produced by catalogued services', () => {
    const types = eventContracts.map((contract) => contract.type);
    expect(new Set(types).size).toBe(types.length);
    for (const contract of eventContracts) {
      expect(contract.type).toMatch(/\.v\d+$/);
      expect(contract.producers.length).toBeGreaterThan(0);
      for (const producer of contract.producers) expect(isServiceName(producer)).toBe(true);
    }
  });

  it('carries changed field names, never values, in configuration-changed events', () => {
    const shape = configurationChangedV1.dataSchema.shape;
    expect(Object.keys(shape)).not.toContain('oldValue');
    expect(Object.keys(shape)).not.toContain('newValue');
  });
});

describe('HTTP contracts', () => {
  it('validates RFC 9457 problem details with ATLAS extensions', () => {
    const problem = {
      type: problemTypeFor('VALIDATION_FAILED'),
      title: 'Request validation failed',
      status: 400,
      code: 'VALIDATION_FAILED',
      correlationId: randomUUID(),
      issues: [{ path: 'body.slug', message: 'Required' }],
    };
    expect(problemDetailsSchema.parse(problem).type).toBe('urn:atlas:problem:validation-failed');
    expect(problemDetailsSchema.safeParse({ ...problem, code: 'MADE_UP' }).success).toBe(false);
    expect(problemDetailsSchema.safeParse({ ...problem, status: 200 }).success).toBe(false);
  });

  it('validates readiness responses', () => {
    const ready = readinessResponseSchema.safeParse({
      status: 'not_ready',
      service: 'acs-core',
      checks: [{ name: 'postgres', status: 'down', latencyMs: 12, error: 'timeout' }],
    });
    expect(ready.success).toBe(true);
    expect(
      readinessResponseSchema.safeParse({ status: 'ready', service: 'unknown', checks: [] })
        .success,
    ).toBe(false);
  });

  it('wraps platform services in the success envelope', () => {
    const result = platformServicesResponseSchema.safeParse({
      data: { checkedAt: new Date().toISOString(), services: [] },
      meta: { correlationId: randomUUID(), apiVersion: 'v1' },
    });
    expect(result.success).toBe(true);
  });
});

describe('JSON Schema export', () => {
  it('exports every contract as a JSON Schema document', () => {
    const documents = exportJsonSchemas();
    expect(Object.keys(documents)).toEqual(
      expect.arrayContaining(['event.envelope', 'http.problem-details', tenantCreatedV1.type]),
    );
    for (const document of Object.values(documents)) {
      expect(document).toHaveProperty('$schema', 'https://json-schema.org/draft/2020-12/schema');
    }
  });
});
