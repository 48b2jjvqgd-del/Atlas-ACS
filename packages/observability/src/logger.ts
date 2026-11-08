import { redactSensitive, scrubCardNumbers } from '@atlas/security';
import { pino, type Logger, type LoggerOptions } from 'pino';

/**
 * Structured logging convention.
 *
 * - JSON lines to stdout; the platform (Docker, Kubernetes, systemd…) ships them. Services
 *   never write log files or call external log endpoints directly.
 * - Base fields on every line: service, version, environment.
 * - Request-scoped lines additionally carry reqId and correlationId (added by service-kit).
 * - Every structured field passes through redactSensitive(); every message string is scrubbed
 *   for card numbers. This is a safety net — code must still avoid logging sensitive data.
 */
export interface LoggerSettings {
  service: string;
  version: string;
  environment: string;
  level: string;
  /** Human-readable output for local development only. Never enable in shared environments. */
  pretty?: boolean;
}

export function createLoggerOptions(settings: LoggerSettings): LoggerOptions {
  return {
    level: settings.level,
    base: {
      service: settings.service,
      version: settings.version,
      environment: settings.environment,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'message',
    errorKey: 'error',
    formatters: {
      level: (label) => ({ level: label }),
      log: (object) => redactSensitive(object) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((argument) =>
          typeof argument === 'string' ? scrubCardNumbers(argument) : argument,
        ) as Parameters<typeof method>;
        method.apply(this, scrubbed);
      },
    },
    ...(settings.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { messageKey: 'message', singleLine: true },
          },
        }
      : {}),
  };
}

export function createLogger(
  settings: LoggerSettings,
  destination?: pino.DestinationStream,
): Logger {
  const options = createLoggerOptions(settings);
  return destination ? pino(options, destination) : pino(options);
}

export type { Logger };
