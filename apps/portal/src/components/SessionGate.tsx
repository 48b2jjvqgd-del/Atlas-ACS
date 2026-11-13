import type { ReactNode } from 'react';
import { describeError } from '../lib/api';
import { useSession } from '../lib/session';
import { AtlasLogo } from './AtlasLogo';
import { EnvironmentBadge } from './EnvironmentBadge';
import { Icon } from './Icon';
import { Button, Spinner } from './ui';

/**
 * Renders the application only for a signed-in user. Everything else — not signed in, session
 * expired, gateway unavailable — gets a clear full-page state with one obvious next step.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const { state, signIn, refresh } = useSession();
  if (state.status === 'authenticated') return <>{children}</>;
  if (state.status === 'loading') {
    return (
      <Centered>
        <Spinner label="Checking your session…" />
      </Centered>
    );
  }
  if (state.status === 'expired') {
    return (
      <Centered>
        <h1 className="text-xl font-semibold text-ink">Your session has ended</h1>
        <p className="mt-2 text-sm text-ink-muted" data-testid="session-expired">
          {state.message} For your security, ATLAS signs you out after a period of inactivity.
        </p>
        <Button variant="primary" className="mt-6 w-full" onClick={() => signIn()}>
          <Icon name="lock" className="size-4" /> Sign in again
        </Button>
      </Centered>
    );
  }
  if (state.status === 'unavailable') {
    const { detail, reference } = describeError(state.error);
    return (
      <Centered>
        <h1 className="text-xl font-semibold text-ink">ATLAS is unavailable</h1>
        <p className="mt-2 text-sm text-ink-muted">{detail}</p>
        {reference && (
          <p className="mt-2 font-mono text-[11px] text-ink-subtle">Reference {reference}</p>
        )}
        <Button className="mt-6 w-full" onClick={() => void refresh()}>
          <Icon name="refresh" className="size-4" /> Try again
        </Button>
      </Centered>
    );
  }
  return (
    <Centered>
      <h1 className="text-xl font-semibold text-ink">Sign in to ATLAS</h1>
      <p className="mt-2 text-sm leading-6 text-ink-muted">
        The issuer administration platform for the ATLAS Access Control Server. Platform
        administrators are asked for a one-time code from their authenticator app.
      </p>
      <Button
        variant="primary"
        className="mt-6 w-full"
        onClick={() => signIn()}
        data-testid="sign-in"
      >
        <Icon name="lock" className="size-4" /> Sign in
      </Button>
      <p className="mt-6 text-[11px] leading-5 text-ink-subtle">
        Non-production build · synthetic data only · no scheme connectivity.
      </p>
    </Centered>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4">
      <div className="mb-8 flex items-center gap-4">
        <AtlasLogo />
        <EnvironmentBadge />
      </div>
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-8 shadow-2xl">
        {children}
      </div>
    </div>
  );
}
