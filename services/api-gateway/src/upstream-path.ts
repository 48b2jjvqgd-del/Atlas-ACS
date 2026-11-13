/**
 * Which portal paths the gateway may forward to a service.
 *
 * The gateway calls services *as itself*: its service token is legitimately accepted on some
 * service-only routes (e.g. principal resolution at identity-service). If the gateway forwarded a
 * path that the HTTP client later rewrites — dot segments ("/users/../../internal/..."), their
 * percent-encoded forms, encoded slashes or backslashes — a signed-in portal user could reach such
 * a route with the gateway's identity (a confused deputy), whatever the route table matched.
 *
 * So only canonical paths are forwarded: segments of unreserved characters only (the API's ids,
 * slugs and keys need nothing else), no empty, dot or encoded segments, nothing under /internal/,
 * and a final check that URL parsing leaves the path unchanged. Anything else is a 404.
 */
const SEGMENT = /^[A-Za-z0-9_~-]+$/;
const UPSTREAM_BASE = 'http://upstream.invalid';

export function forwardablePath(url: string): { pathname: string; search: string } | null {
  const queryStart = url.indexOf('?');
  const pathname = queryStart === -1 ? url : url.slice(0, queryStart);
  const search = queryStart === -1 ? '' : url.slice(queryStart);
  if (!pathname.startsWith('/v1/') || pathname.length > 512) return null;
  const segments = pathname.slice(1).split('/');
  if (!segments.every((segment) => SEGMENT.test(segment))) return null;
  if (segments.includes('internal')) return null;
  let parsed: URL;
  try {
    parsed = new URL(`${pathname}${search}`, UPSTREAM_BASE);
  } catch {
    return null;
  }
  if (parsed.origin !== UPSTREAM_BASE || parsed.pathname !== pathname) return null;
  return { pathname, search };
}
