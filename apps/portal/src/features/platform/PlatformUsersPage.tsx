import type { PlatformUser } from '@atlas/contracts';
import { useState } from 'react';
import { Card } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { PageHeader } from '../../components/PageHeader';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  SkeletonRows,
  Table,
  Td,
  Th,
  formatRelative,
  useToast,
} from '../../components/ui';
import { identity } from '../../lib/endpoints';
import { useSession } from '../../lib/session';
import { useResource } from '../../lib/use-api';
import { UserStatus } from '../shared/IssuerStatus';
import { roleName } from '../shared/RoleChecklist';
import { InviteDialog, RolesDialog } from '../shared/TenantUsers';

export function PlatformUsersPage() {
  const { can, session } = useSession();
  const toast = useToast();
  const manage = can('platform.users.manage');
  const users = useResource('platform-users', (signal) => identity.platformUsers(signal));
  const roles = useResource('roles', (signal) => identity.roles(signal));
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<PlatformUser | null>(null);
  const [toggling, setToggling] = useState<PlatformUser | null>(null);
  const roleList = roles.state.status === 'loaded' ? roles.state.data : undefined;

  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="Platform users"
        description="People who operate ATLAS across all issuers. Platform roles require a second factor at sign-in."
        actions={
          manage && (
            <Button variant="primary" onClick={() => setInviting(true)}>
              <Icon name="plus" className="size-4" /> Invite platform user
            </Button>
          )
        }
      />
      <Card>
        {users.state.status === 'loading' && <SkeletonRows />}
        {users.state.status === 'error' && (
          <ErrorState error={users.state.error} onRetry={() => void users.reload()} />
        )}
        {users.state.status === 'loaded' && users.state.data.length === 0 && (
          <EmptyState title="No platform users" />
        )}
        {users.state.status === 'loaded' && users.state.data.length > 0 && (
          <Table minWidth={760}>
            <thead>
              <tr>
                <Th>User</Th>
                <Th>Platform roles</Th>
                <Th>Status</Th>
                <Th>Last sign-in</Th>
                {manage && <Th align="right">Actions</Th>}
              </tr>
            </thead>
            <tbody data-testid="platform-users">
              {users.state.data.map((user) => (
                <tr key={user.id}>
                  <Td>
                    <p className="font-medium text-ink">{user.displayName}</p>
                    <p className="text-xs text-ink-subtle">{user.email}</p>
                  </Td>
                  <Td className="text-ink-muted">
                    {user.roles.map((key) => roleName(roleList, key)).join(', ')}
                  </Td>
                  <Td>
                    <UserStatus status={user.status} />
                  </Td>
                  <Td className="text-ink-muted">{formatRelative(user.lastSignInAt)}</Td>
                  {manage && (
                    <Td className="text-right">
                      {user.id === session?.principal.userId ? (
                        <span className="text-xs text-ink-subtle">You</span>
                      ) : (
                        <span className="inline-flex gap-1">
                          <Button variant="ghost" onClick={() => setEditing(user)}>
                            Roles
                          </Button>
                          <Button variant="ghost" onClick={() => setToggling(user)}>
                            {user.status === 'disabled' ? 'Enable' : 'Disable'}
                          </Button>
                        </span>
                      )}
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {inviting && roleList && (
        <InviteDialog
          title="Invite a platform user"
          roles={roleList}
          scope="platform"
          onClose={() => setInviting(false)}
          onSubmit={async (body) => {
            await identity.invitePlatformUser(body);
            toast(
              'success',
              `${body.email} invited. They must set a password and enrol a second factor.`,
            );
            setInviting(false);
            await users.reload();
          }}
        />
      )}
      {editing && roleList && (
        <RolesDialog
          title={`Platform roles for ${editing.displayName}`}
          roles={roleList}
          scope="platform"
          initial={editing.roles}
          onClose={() => setEditing(null)}
          onSubmit={async (selected) => {
            await identity.setPlatformRoles(editing.id, selected);
            toast('success', `Platform roles updated for ${editing.displayName}.`);
            setEditing(null);
            await users.reload();
          }}
        />
      )}
      {toggling && (
        <ConfirmDialog
          title={`${toggling.status === 'disabled' ? 'Enable' : 'Disable'} ${toggling.displayName}?`}
          description={
            toggling.status === 'disabled'
              ? 'They can sign in again with their existing roles.'
              : 'They are signed out everywhere immediately.'
          }
          confirmLabel={toggling.status === 'disabled' ? 'Enable account' : 'Disable account'}
          tone={toggling.status === 'disabled' ? 'primary' : 'danger'}
          requireReason
          onClose={() => setToggling(null)}
          onConfirm={async (reason) => {
            await identity.setUserStatus(
              toggling.id,
              toggling.status === 'disabled' ? 'active' : 'disabled',
              reason,
            );
            toast('success', `${toggling.displayName} updated.`);
            setToggling(null);
            await users.reload();
          }}
        />
      )}
    </>
  );
}
