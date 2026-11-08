import { z } from '@atlas/schemas';

/**
 * Service catalogue: the single source of truth for service identity.
 *
 * A service's name is how it identifies itself (logs, metrics, the x-atlas-caller header,
 * event "source"), and the name of the database schema and Valkey key prefix it owns.
 * Default ports are for local development only; deployments inject PORT explicitly.
 */
export const serviceCatalog = {
  'api-gateway': {
    port: 4000,
    domain: 'edge',
    summary:
      'Single entry point for the portal and external callers; routing, rate limiting, CORS.',
    dataStores: { postgresSchema: null, valkeyPrefix: 'atlas:api-gateway:' },
  },
  'acs-core': {
    port: 4001,
    domain: 'authentication',
    summary: 'Orchestrates the 3DS authentication lifecycle; scheme-agnostic.',
    dataStores: { postgresSchema: 'acs', valkeyPrefix: 'atlas:acs-core:' },
  },
  protocol: {
    port: 4002,
    domain: 'authentication',
    summary: 'EMV 3DS message parsing, validation and version negotiation. Stateless.',
    dataStores: { postgresSchema: null, valkeyPrefix: null },
  },
  'visa-adapter': {
    port: 4003,
    domain: 'scheme',
    summary: 'Visa Secure specific behaviour and directory server connectivity.',
    dataStores: { postgresSchema: null, valkeyPrefix: null },
  },
  'mastercard-adapter': {
    port: 4004,
    domain: 'scheme',
    summary: 'Mastercard Identity Check specific behaviour and directory server connectivity.',
    dataStores: { postgresSchema: null, valkeyPrefix: null },
  },
  'fraud-engine': {
    port: 4005,
    domain: 'risk',
    summary: 'Issuer-configurable risk rules and risk assessment.',
    dataStores: { postgresSchema: 'fraud', valkeyPrefix: null },
  },
  'compliance-engine': {
    port: 4006,
    domain: 'risk',
    summary: 'Regulatory and scheme compliance evaluation (e.g. SCA exemptions).',
    dataStores: { postgresSchema: 'compliance', valkeyPrefix: null },
  },
  'challenge-engine': {
    port: 4007,
    domain: 'authentication',
    summary: 'Cardholder challenge sessions and authentication-method orchestration.',
    dataStores: { postgresSchema: 'challenge', valkeyPrefix: 'atlas:challenge-engine:' },
  },
  'issuer-service': {
    port: 4008,
    domain: 'platform',
    summary: 'Issuer (tenant) registry and issuer configuration.',
    dataStores: { postgresSchema: 'issuer', valkeyPrefix: null },
  },
  'cardholder-service': {
    port: 4009,
    domain: 'platform',
    summary: 'Cardholder enrolment and authentication-method registration.',
    dataStores: { postgresSchema: 'cardholder', valkeyPrefix: null },
  },
  'identity-service': {
    port: 4010,
    domain: 'platform',
    summary: 'Portal identity, roles and permissions; integrates with an external IdP.',
    dataStores: { postgresSchema: 'identity', valkeyPrefix: null },
  },
  'reporting-service': {
    port: 4011,
    domain: 'insight',
    summary: 'Read-optimised projections and reports built from platform events.',
    dataStores: { postgresSchema: 'reporting', valkeyPrefix: null },
  },
  'audit-service': {
    port: 4012,
    domain: 'insight',
    summary: 'Tamper-evident audit trail of configuration changes and decisions.',
    dataStores: { postgresSchema: 'audit', valkeyPrefix: null },
  },
} as const;

export type ServiceName = keyof typeof serviceCatalog;

export const serviceNames = Object.keys(serviceCatalog) as [ServiceName, ...ServiceName[]];

export const serviceNameSchema = z.enum(serviceNames);

export function isServiceName(value: string): value is ServiceName {
  return Object.hasOwn(serviceCatalog, value);
}
