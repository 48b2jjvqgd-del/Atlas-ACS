import { Card } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { PageHeader } from '../../components/PageHeader';
import { StatusPill } from '../../components/StatusPill';
import { Button, KeyValues, formatDateTime } from '../../components/ui';
import { useSession } from '../../lib/session';
import { useTenant } from '../../lib/tenant';

/** The signed-in user's account and session. Passwords and second factors are managed at the identity provider. */
export function AccountPage() {
  const { session, signOut } = useSession();
  const { names } = useTenant();
  if (!session) return null;
  const { principal } = session;
  const hasPlatformRoles = principal.platformRoles.length > 0;
  return (
    <>
      <PageHeader
        eyebrow="Account"
        title="Account and security"
        description="Your profile, access and current session."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Profile">
          <KeyValues
            items={[
              { label: 'Name', value: principal.displayName },
              { label: 'Email', value: principal.email },
              { label: 'Account', value: <StatusPill tone="ok">Active</StatusPill> },
              {
                label: 'User ID',
                value: <span className="font-mono text-xs">{principal.userId}</span>,
              },
            ]}
          />
        </Card>
        <Card
          title="Sign-in security"
          description="ATLAS never sees your password. Change it, or manage your authenticator app, at the identity provider."
          actions={
            session.accountUrl && (
              <a href={session.accountUrl} target="_blank" rel="noreferrer noopener">
                <Button>
                  <Icon name="key" className="size-4" /> Manage password and 2-step
                </Button>
              </a>
            )
          }
        >
          <KeyValues
            items={[
              {
                label: '2-step verification this session',
                value: (
                  <StatusPill tone={session.mfa ? 'ok' : hasPlatformRoles ? 'warn' : 'neutral'}>
                    {session.mfa ? 'Used' : 'Not used'}
                  </StatusPill>
                ),
              },
              { label: 'Signed in', value: formatDateTime(session.authenticatedAt) },
              { label: 'Session ends by', value: formatDateTime(session.expiresAt) },
              { label: 'Idle timeout at', value: formatDateTime(session.idleExpiresAt) },
            ]}
          />
          {hasPlatformRoles && !session.mfa && (
            <p className="mt-4 text-sm text-warn">
              Platform permissions are withheld in this session because it was not verified with a
              second factor.
            </p>
          )}
        </Card>
        <Card title="Access">
          <div className="space-y-3 text-sm">
            <div>
              <p className="text-xs uppercase tracking-wider text-ink-subtle">Platform roles</p>
              <p className="mt-1 text-ink">{principal.platformRoles.join(', ') || 'None'}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-ink-subtle">Issuer memberships</p>
              {principal.tenants.length === 0 ? (
                <p className="mt-1 text-ink">None</p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {principal.tenants.map((tenant) => (
                    <li key={tenant.tenantId} className="text-ink">
                      {names[tenant.tenantId] ?? tenant.tenantId}{' '}
                      <span className="text-ink-subtle">— {tenant.roles.join(', ')}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Card>
        <Card
          title="Sign out"
          description="Ends your ATLAS session and your identity-provider session."
        >
          <Button variant="danger" onClick={() => void signOut()}>
            <Icon name="logout" className="size-4" /> Sign out
          </Button>
        </Card>
      </div>
    </>
  );
}
