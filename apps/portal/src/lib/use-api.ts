import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError } from './api';

export type Resource<T> =
  | { status: 'loading' }
  | { status: 'loaded'; data: T; reloading: boolean }
  | { status: 'error'; error: ApiError };

const toApiError = (error: unknown) =>
  error instanceof ApiError ? error : new ApiError('Unexpected error', 'unreachable', 'n/a');

/**
 * Loads a resource and exposes loading, loaded and error states plus a reload function.
 * `key` identifies the resource: a new key loads afresh; pass null to skip loading (e.g. no
 * permission). Reloading keeps the current data visible until the new data arrives.
 */
export function useResource<T>(
  key: string | null,
  load: (signal: AbortSignal) => Promise<T>,
): { state: Resource<T>; reload: () => Promise<void> } {
  const [entry, setEntry] = useState<{
    key: string | null;
    generation: number;
    state: Resource<T>;
  }>({
    key: null,
    generation: 0,
    state: { status: 'loading' },
  });
  const [generation, setGeneration] = useState(0);
  const loader = useRef(load);
  useLayoutEffect(() => {
    loader.current = load;
  });

  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    loader.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted)
          setEntry({ key, generation, state: { status: 'loaded', data, reloading: false } });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setEntry({ key, generation, state: { status: 'error', error: toApiError(error) } });
      },
    );
    return () => controller.abort();
  }, [key, generation]);

  let state: Resource<T> = entry.key === key ? entry.state : { status: 'loading' };
  if (state.status === 'loaded' && entry.generation !== generation)
    state = { ...state, reloading: true };
  const reload = useCallback(async () => setGeneration((value) => value + 1), []);
  return { state, reload };
}
