import {
  correlationIdSchema,
  isoTimestampSchema,
  tenantIdSchema,
  uuidSchema,
  z,
} from '@atlas/schemas';
import type { serviceNameSchema } from '../services.js';

/**
 * Asynchronous event envelope — CloudEvents 1.0 structured JSON mode.
 *
 * Standard attributes: specversion, id, source, type, time, datacontenttype, dataschema, data.
 * ATLAS extension attributes (CloudEvents requires lowercase alphanumeric names):
 *   correlationid  correlation ID of the originating request
 *   tenantid       owning issuer, when the event is tenant-scoped
 *
 * Event "type" naming: atlas.<domain>.<entity>-<past-tense-verb>.v<major>
 * The type string is also the RabbitMQ routing key.
 */
export const eventTypeSchema = z
  .string()
  .regex(
    /^atlas\.[a-z]+(?:-[a-z]+)*\.[a-z]+(?:-[a-z]+)*\.v[1-9]\d*$/,
    'Event type must match atlas.<domain>.<name>.v<major>',
  );

export const eventEnvelopeSchema = z.object({
  specversion: z.literal('1.0'),
  id: uuidSchema,
  source: z.string().regex(/^urn:atlas:service:[a-z-]+$/),
  type: eventTypeSchema,
  time: isoTimestampSchema,
  datacontenttype: z.literal('application/json'),
  dataschema: z.string(),
  correlationid: correlationIdSchema,
  tenantid: tenantIdSchema.optional(),
  data: z.unknown(),
});

export type EventEnvelope<T = unknown> = Omit<z.infer<typeof eventEnvelopeSchema>, 'data'> & {
  data: T;
};

export interface EventContract<T extends z.ZodType = z.ZodType> {
  readonly type: string;
  /** Services permitted to publish this event. */
  readonly producers: readonly z.infer<typeof serviceNameSchema>[];
  readonly dataSchema: T;
  readonly schemaUri: string;
  readonly description: string;
}

/**
 * Declares an event contract. Evolution rules:
 *  - Adding an optional field is backwards-compatible: keep the same major version.
 *  - Removing/renaming a field or changing its meaning or type is breaking: publish a new
 *    type with an incremented major (…v2) and run both in parallel until consumers migrate.
 */
export function defineEvent<T extends z.ZodType>(
  definition: {
    type: string;
    dataSchema: T;
    description: string;
  } & (
    | { producer: z.infer<typeof serviceNameSchema> }
    | { producers: readonly z.infer<typeof serviceNameSchema>[] }
  ),
): EventContract<T> {
  eventTypeSchema.parse(definition.type);
  const producers = 'producers' in definition ? definition.producers : [definition.producer];
  return {
    type: definition.type,
    producers,
    dataSchema: definition.dataSchema,
    description: definition.description,
    schemaUri: `urn:atlas:contract:event:${definition.type}`,
  };
}

/** Validates the envelope and the payload against the contract. Throws ZodError on failure. */
export function parseEvent<T extends z.ZodType>(
  contract: EventContract<T>,
  raw: unknown,
): EventEnvelope<z.infer<T>> {
  const envelope = eventEnvelopeSchema.parse(raw);
  if (envelope.type !== contract.type) {
    throw new Error(`Event type mismatch: expected ${contract.type}`);
  }
  return { ...envelope, data: contract.dataSchema.parse(envelope.data) };
}
