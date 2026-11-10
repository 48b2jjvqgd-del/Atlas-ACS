import { Navigate } from 'react-router';
import { EmptyState } from '../../components/ui';
import { useSession } from '../../lib/session';

/** Sends each user to the workspace they can use: platform users to the platform, others to their issuer. */
export function DashboardPage() {
  const { session, authz } = useSession();
  if (!session || !authz) return null;
  if (session.principal.platformPermissions.length > 0) return <Navigate to="/platform" replace />;
  if (session.principal.tenants.length > 0) return <Navigate to="/issuer" replace />;
  return (
    <EmptyState title="No access yet">
      {session.principal.platformRoles.length > 0
        ? 'Your platform roles need a sign-in with 2-step verification. Sign out and sign in again with your authenticator app.'
        : 'Your account has no roles. Ask an administrator to grant you access to an issuer.'}
    </EmptyState>
  );
}
