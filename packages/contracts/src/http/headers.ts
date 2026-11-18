/**
 * HTTP header conventions for ATLAS-internal and portal APIs.
 *
 * - authorization: `Bearer <service token>` on every service-to-service call (Stage 1A). The
 *   callee authenticates the calling *service* from this OAuth 2.0 client-credentials token.
 * - x-atlas-user-token: the end user's access token, forwarded by the gateway (and by services
 *   acting on the user's behalf). The callee validates it independently; it is never logged.
 * - x-atlas-caller: service *identification* for diagnostics only. It is not authentication and
 *   must never be used for an authorisation decision — the service token is.
 */
export const headers = {
  correlationId: 'x-correlation-id',
  requestId: 'x-request-id',
  caller: 'x-atlas-caller',
  userToken: 'x-atlas-user-token',
  authorization: 'authorization',
  apiVersion: 'x-atlas-api-version',
} as const;

export const problemContentType = 'application/problem+json';
