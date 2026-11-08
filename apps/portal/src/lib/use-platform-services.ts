import type { PlatformServices } from '@atlas/contracts';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, fetchPlatformServices } from './api';

export type PlatformServicesState =
  | { status: 'loading' }
  | { status: 'loaded'; data: PlatformServices }
  | { status: 'error'; error: ApiError };

/** Live platform service status from the gateway, refreshed on an interval. */
export function usePlatformServices(refreshMs = 15_000) {
  const [state, setState] = useState<PlatformServicesState>({ status: 'loading' });

  const refresh = useCallback(async () => {
    try {
      setState({ status: 'loaded', data: await fetchPlatformServices() });
    } catch (error) {
      setState({
        status: 'error',
        error:
          error instanceof ApiError
            ? error
            : new ApiError('Unexpected error', 'unreachable', 'n/a'),
      });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (!cancelled) void refresh();
    };
    run();
    const timer = window.setInterval(run, refreshMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refresh, refreshMs]);

  return { state, refresh };
}
