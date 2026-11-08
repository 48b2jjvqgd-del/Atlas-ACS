import { z } from 'zod';

/**
 * Converts a Zod schema to JSON Schema (draft 2020-12) so contracts can be published to, and
 * validated by, non-TypeScript consumers. Zod remains the single source of truth.
 */
export function toJsonSchema(schema: z.ZodType, options: { id?: string; title?: string } = {}) {
  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' });
  return {
    ...jsonSchema,
    ...(options.id ? { $id: options.id } : {}),
    ...(options.title ? { title: options.title } : {}),
  };
}
