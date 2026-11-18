import { isServiceName, serviceCatalog, serviceNames, type ServiceName } from '@atlas/contracts';

/**
 * Resolves where each service can be reached.
 *
 * Defaults to http://127.0.0.1:<catalogue port> for local development. Deployments supply
 * ATLAS_SERVICE_URLS as "name=url,name=url"; Docker Compose uses this to point at container
 * hostnames. Unknown service names are rejected so a typo cannot silently drop a service.
 */
export function resolveServiceUrls(override: string | undefined): Record<ServiceName, string> {
  const urls = Object.fromEntries(
    serviceNames.map((name) => [name, `http://127.0.0.1:${serviceCatalog[name].port}`]),
  ) as Record<ServiceName, string>;

  for (const entry of (override ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)) {
    const separator = entry.indexOf('=');
    const name = entry.slice(0, separator);
    const url = entry.slice(separator + 1);
    if (separator < 1 || !isServiceName(name)) {
      throw new Error(`ATLAS_SERVICE_URLS contains an unknown service entry "${name || entry}"`);
    }
    if (!/^https?:\/\/[^\s]+$/.test(url)) {
      throw new Error(`ATLAS_SERVICE_URLS has an invalid URL for ${name}`);
    }
    urls[name] = url;
  }
  return urls;
}
