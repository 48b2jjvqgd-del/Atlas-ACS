import { describe, expect, it } from 'vitest';
import {
  booleanStringSchema,
  commaListSchema,
  correlationIdSchema,
  portSchema,
  tenantSlugSchema,
  toJsonSchema,
  urlWithProtocols,
  z,
} from './index.js';

describe('correlationIdSchema', () => {
  it('accepts UUIDs and opaque upstream tokens', () => {
    expect(correlationIdSchema.safeParse('3f2a1c9e-8d4b-4c1a-9e2f-7b6a5d4c3b2a').success).toBe(
      true,
    );
    expect(correlationIdSchema.safeParse('upstream:trace.42-abc').success).toBe(true);
  });

  it('rejects values that would be unsafe to log or echo in a header', () => {
    expect(correlationIdSchema.safeParse('abc\r\nSet-Cookie: x=1').success).toBe(false);
    expect(correlationIdSchema.safeParse('<script>alert(1)</script>').success).toBe(false);
    expect(correlationIdSchema.safeParse('a'.repeat(129)).success).toBe(false);
    expect(correlationIdSchema.safeParse('short').success).toBe(false);
  });
});

describe('tenantSlugSchema', () => {
  it('enforces lowercase kebab-case', () => {
    expect(tenantSlugSchema.safeParse('demo-bank').success).toBe(true);
    expect(tenantSlugSchema.safeParse('Demo Bank').success).toBe(false);
    expect(tenantSlugSchema.safeParse('-demo').success).toBe(false);
  });
});

describe('configuration parsers', () => {
  it('coerces ports and rejects out-of-range values', () => {
    expect(portSchema.parse('4001')).toBe(4001);
    expect(portSchema.safeParse('70000').success).toBe(false);
    expect(portSchema.safeParse('abc').success).toBe(false);
  });

  it('parses booleans strictly', () => {
    expect(booleanStringSchema.parse('true')).toBe(true);
    expect(booleanStringSchema.parse('0')).toBe(false);
    expect(booleanStringSchema.safeParse('yes').success).toBe(false);
  });

  it('restricts URL protocols', () => {
    const postgres = urlWithProtocols(['postgres:', 'postgresql:']);
    expect(postgres.safeParse('postgres://user:pw@localhost:5432/atlas').success).toBe(true);
    expect(postgres.safeParse('http://localhost:5432').success).toBe(false);
  });

  it('splits comma-separated lists', () => {
    expect(commaListSchema.parse(' a, b ,,c ')).toEqual(['a', 'b', 'c']);
  });
});

describe('toJsonSchema', () => {
  it('produces a draft 2020-12 JSON Schema with an $id', () => {
    const schema = toJsonSchema(z.object({ id: z.uuid(), count: z.number().int() }), {
      id: 'https://schemas.atlas-acs.dev/example.json',
    });
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe('https://schemas.atlas-acs.dev/example.json');
    expect(schema).toMatchObject({ type: 'object', required: ['id', 'count'] });
  });
});
