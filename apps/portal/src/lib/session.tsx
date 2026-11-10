import {
  authorizer,
  logoutResponseSchema,
  sessionResponseSchema,
  type Authorizer,
  type Permission,
  type Session,
} from '@atlas/contracts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, apiRequest, configureApi } from './api';

/**
 * Portal session state.
 *
 * The session lives at the gateway; the portal only asks for it (GET /v1/session) and reacts.
 * Permissions shown here come from the gateway's verified principal and drive what the portal
 * offers. They are a usability aid only: every API call is authorised again by the services.
 */
export type SessionState =
  | { status: 'loading' }
  | { status: 'anonymous'; reason?: string }
  | { status: 'expired'; message: string }
  | { status: 'unavailable'; error: ApiError }
  | { status: 'authenticated'; session: Session };

interface SessionContextValue {
  state: SessionState;
  session: Session | null;
  authz: Authorizer | null;
  can(permission: Permission, tenantId?: string): boolean;
  signIn(returnTo?: string): void;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  const refresh = useCallback(async () => {
    try {
      const { body } = await apiRequest('GET', '/v1/session', {
        schema: sessionResponseSchema,
        quietUnauthenticated: true,
      });
      configureApi({ csrfToken: body.data.csrfToken });
      setState({ status: 'authenticated', session: body.data });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        configureApi({});
        setState((current) =>
          current.status === 'authenticated' || /expired/i.test(error.message)
            ? { status: 'expired', message: error.message }
            : { status: 'anonymous' },
        );
      } else {
        setState({
          status: 'unavailable',
          error:
            error instanceof ApiError
              ? error
              : new ApiError('Unexpected error', 'unreachable', 'n/a'),
        });
      }
    }
  }, []);

  useEffect(() => {
    configureApi({
      onUnauthenticated: (message) => {
        configureApi({});
        setState({ status: 'expired', message });
      },
    });
    void refresh();
  }, [refresh]);

  // Re-check when the idle expiry passes, so an idle tab shows "session expired" promptly.
  useEffect(() => {
    if (state.status !== 'authenticated') return;
    const idleAt = new Date(state.session.idleExpiresAt).getTime();
    const delay = Math.max(5_000, Math.min(idleAt - Date.now() + 1_000, 2_147_000_000));
    const timer = window.setTimeout(() => void refresh(), delay);
    return () => window.clearTimeout(timer);
  }, [state, refresh]);

  const value = useMemo<SessionContextValue>(() => {
    const session = state.status === 'authenticated' ? state.session : null;
    const authz = session ? authorizer(session.principal) : null;
    return {
      state,
      session,
      authz,
      can: (permission, tenantId) => authz?.can(permission, tenantId) ?? false,
      signIn(returnTo) {
        const target = returnTo ?? `${window.location.pathname}${window.location.search}`;
        window.location.assign(
          `/api/v1/auth/login?returnTo=${encodeURIComponent(target.startsWith('/') ? target : '/')}`,
        );
      },
      async signOut() {
        try {
          const { body } = await apiRequest('POST', '/v1/auth/logout', {
            schema: logoutResponseSchema,
          });
          configureApi({});
          if (body.data.endSessionUrl) {
            window.location.assign(body.data.endSessionUrl);
            return;
          }
        } catch {
          /* fall through: the local session is gone either way */
        }
        window.location.assign('/signed-out');
      },
      refresh,
    };
  }, [state, refresh]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
