import { readFileSync } from 'node:fs';
import { startTracingFromEnvironment } from '@atlas/observability';

// Tracing starts before the HTTP server, HTTP clients and database driver are loaded, so that
// they are instrumented. Everything else is imported afterwards.
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  version: string;
};
startTracingFromEnvironment('api-gateway', version);

const { runService } = await import('@atlas/service-kit');
const { definition } = await import('./service.js');
await runService(definition);
