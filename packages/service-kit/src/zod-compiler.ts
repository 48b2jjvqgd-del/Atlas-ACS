import type { z } from '@atlas/schemas';
import type { FastifyInstance } from 'fastify';

/**
 * Lets routes declare Zod schemas directly in Fastify's `schema` option:
 *
 *   app.get('/v1/tenants/:tenantId', { schema: { params: getTenantParamsSchema } }, handler)
 *
 * Validation failures surface as ZodErrors and are rendered as VALIDATION_FAILED problems.
 * Response serialisation uses JSON.stringify: response shapes are guaranteed by TypeScript
 * types and contract tests rather than by runtime serialisation schemas.
 */
export function installZodCompilers(app: FastifyInstance): void {
  app.setValidatorCompiler(({ schema }) => {
    const zodSchema = schema as unknown as z.ZodType;
    return (data: unknown) => {
      const result = zodSchema.safeParse(data);
      return result.success ? { value: result.data } : { error: result.error };
    };
  });
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
}
