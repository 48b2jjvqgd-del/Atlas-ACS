import {
  problemContentType,
  problemTypeFor,
  type ProblemDetails,
  type ValidationIssue,
} from '@atlas/contracts';
import { z } from '@atlas/schemas';
import { AtlasError, errorCodes, type ErrorCode } from '@atlas/shared';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Error-handling convention.
 *
 * - AtlasError → its code and status; detail is exposed (it is written to be client-safe).
 * - Validation failures (Zod, Fastify schema) → VALIDATION_FAILED with field-level issues.
 * - Recognised framework errors (bad JSON, body too large, …) → the matching 4xx code.
 * - Anything else → INTERNAL_ERROR with a generic message. The original error is logged,
 *   never returned to the client.
 */
export function toProblem(error: unknown, request: FastifyRequest): ProblemDetails {
  const base = (code: ErrorCode, detail?: string, issues?: ValidationIssue[]): ProblemDetails => ({
    type: problemTypeFor(code),
    title: errorCodes[code].title,
    status: errorCodes[code].status,
    ...(detail ? { detail } : {}),
    instance: request.url.split('?')[0],
    code,
    correlationId: request.correlationId,
    ...(issues ? { issues } : {}),
  });

  if (error instanceof AtlasError) {
    const issues = error.details?.issues as ValidationIssue[] | undefined;
    return base(error.code, error.detail, issues);
  }
  if (error instanceof z.ZodError) {
    const context = (error as { validationContext?: string }).validationContext;
    return base('VALIDATION_FAILED', undefined, zodIssues(error, context));
  }

  const fastifyError = error as Partial<FastifyError>;
  if (fastifyError.validation) {
    return base(
      'VALIDATION_FAILED',
      undefined,
      fastifyError.validation.map((issue) => ({
        path: [fastifyError.validationContext, issue.instancePath].filter(Boolean).join(''),
        message: issue.message ?? 'is invalid',
      })),
    );
  }
  switch (fastifyError.statusCode) {
    case 400:
      return base(
        'BAD_REQUEST',
        fastifyError.code === 'FST_ERR_CTP_INVALID_JSON_BODY'
          ? 'Body is not valid JSON'
          : undefined,
      );
    case 404:
      return base('NOT_FOUND');
    case 405:
      return base('METHOD_NOT_ALLOWED');
    case 413:
      return base('PAYLOAD_TOO_LARGE');
    case 415:
      return base('UNSUPPORTED_MEDIA_TYPE');
    case 429:
      return base('RATE_LIMITED');
    case 503:
      return base('SERVICE_UNAVAILABLE');
    default:
      return base('INTERNAL_ERROR');
  }
}

export function zodIssues(error: z.ZodError, context?: string): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: [context, ...issue.path.map(String)].filter(Boolean).join('.'),
    message: issue.message,
  }));
}

export function sendProblem(reply: FastifyReply, problem: ProblemDetails): FastifyReply {
  return reply.status(problem.status).type(problemContentType).send(problem);
}
