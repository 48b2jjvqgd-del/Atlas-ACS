/**
 * HTTP header conventions for ATLAS-internal and portal APIs.
 *
 * NOTE: x-atlas-caller is service *identification* for diagnostics only. It is not
 * authentication and must never be used for an authorisation decision. Service-to-service
 * authentication (mTLS + signed service tokens) is designed in docs/security/SECURITY_MODEL.md
 * and is scheduled for a later stage.
 */
export const headers = {
  correlationId: 'x-correlation-id',
  requestId: 'x-request-id',
  caller: 'x-atlas-caller',
  apiVersion: 'x-atlas-api-version',
} as const;

export const problemContentType = 'application/problem+json';
