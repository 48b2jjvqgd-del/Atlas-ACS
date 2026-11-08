import { correlationIdSchema, z } from '@atlas/schemas';

/**
 * Success response contract for ATLAS platform APIs:
 *   { "data": <resource or collection>, "meta": { "correlationId": "...", ... } }
 *
 * "data" carries the resource; "meta" carries request-scoped information. Pagination and
 * other cross-cutting metadata are added to "meta" as optional fields so that adding them
 * is backwards-compatible.
 */
export const responseMetaSchema = z.object({
  correlationId: correlationIdSchema,
  apiVersion: z.string(),
});

export function successEnvelope<T extends z.ZodType>(data: T) {
  return z.object({ data, meta: responseMetaSchema });
}

export type ResponseMeta = z.infer<typeof responseMetaSchema>;
export interface SuccessEnvelope<T> {
  data: T;
  meta: ResponseMeta;
}
