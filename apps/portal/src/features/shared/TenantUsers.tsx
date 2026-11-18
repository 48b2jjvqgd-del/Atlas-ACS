import type { Role, TenantUser } from '@atlas/contracts';
import { useState } from 'react';
import { Icon } from '../../components/Icon';
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  SkeletonRows,
  Table,
  Td,
  TextInput,
  Th,
  formatRelative,
  useToast,
} from '../../components/ui';
import { identity } from '../../lib/endpoints';
import { useSession } from '../../lib/session';
import { useResource } from '../../lib/use-api';
import { UserStatus } from './IssuerStatus';
import { RoleChecklist, roleName } from './RoleChecklist';

/**
 * Users of one issuer. Management actions appear only with issuer.users.manage for this issuer
 * (platform-wide or as a member); the API enforces the same rule regardless.
 */
export function TenantUsers({ tenantId, issuerName }: { tenantId: string; issuerName: string }) {
  const { can, session } = useSession();
  const toast = useToast();
  const manage = can('issuer.users.manage', tenantId);
  const users = useResource(`users:${tenantId}`, (signal) =>
    identity.tenantUsers(tenantId, signal),
  );
  const roles = useResource('roles', (signal) => identity.roles(signal));
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<TenantUser | null>(null);
  const [removing, setRemoving] = useState<TenantUser | null>(null);
  const [toggling, setToggling] = useState<TenantUser | null>(null);
  const roleList = roles.state.status === 'loaded' ? roles.state.data : undefined;
  const self = session?.principal.userId;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-muted">
          People with access to {issuerName}, and their roles within it.
        </p>
        {manage && (
          <Button variant="primary" onClick={() => setInviting(true)}>
            <Icon name="plus" className="size-4" /> Invite user
          </Button>
        )}
      </div>

      {users.state.status === 'loading' && <SkeletonRows />}
      {users.state.status === 'error' && (
        <ErrorState error={users.state.error} onRetry={() => void users.reload()} />
      )}
      {users.state.status === 'loaded' && users.state.data.length === 0 && (
        <EmptyState
          title="No users yet"
          action={
            manage ? (
              <Button onClick={() => setInviting(true)}>Invite the first user</Button>
            ) : undefined
          }
        >
          Invite an issuer administrator to let {issuerName} manage its own users.
        </EmptyState>
      )}
      {users.state.status === 'loaded' && users.state.data.length > 0 && (
        <Table minWidth={760}>
          <thead>
            <tr>
              <Th>User</Th>
              <Th>Roles</Th>
              <Th>Status</Th>
              <Th>Last sign-in</Th>
              {manage && <Th align="right">Actions</Th>}
            </tr>
          </thead>
          <tbody data-testid="tenant-users">
            {users.state.data.map((user) => (
              <tr key={user.id} data-testid={`user-row-${user.email}`}>
                <Td>
                  <p className="font-medium text-ink">{user.displayName}</p>
                  <p className="text-xs text-ink-subtle">{user.email}</p>
                </Td>
                <Td>
                  <span className="flex flex-wrap gap-1">
                    {user.roles.map((key) => (
                      <span
                        key={key}
                        className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-ink-muted ring-1 ring-inset ring-line-strong"
                      >
                        {roleName(roleList, key)}
                      </span>
                    ))}
                  </span>
                </Td>
                <Td>
                  <UserStatus status={user.status} />
                </Td>
                <Td className="text-ink-muted">{formatRelative(user.lastSignInAt)}</Td>
                {manage && (
                  <Td className="text-right">
                    {user.id === self ? (
                      <span className="text-xs text-ink-subtle">You</span>
                    ) : (
                      <span className="inline-flex gap-1">
                        <Button variant="ghost" onClick={() => setEditing(user)}>
                          Roles
                        </Button>
                        <Button variant="ghost" onClick={() => setToggling(user)}>
                          {user.status === 'disabled' ? 'Enable' : 'Disable'}
                        </Button>
                        <Button variant="ghost" onClick={() => setRemoving(user)}>
                          Remove
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

      {inviting && roleList && (
        <InviteDialog
          title={`Invite a user to ${issuerName}`}
          roles={roleList}
          scope="tenant"
          onClose={() => setInviting(false)}
          onSubmit={async (body) => {
            await identity.inviteTenantUser(tenantId, body);
            toast(
              'success',
              `${body.email} invited. They will receive an email to set their password.`,
            );
            setInviting(false);
            await users.reload();
          }}
        />
      )}
      {editing && roleList && (
        <RolesDialog
          title={`Roles for ${editing.displayName}`}
          roles={roleList}
          scope="tenant"
          initial={editing.roles}
          requireOne
          onClose={() => setEditing(null)}
          onSubmit={async (selected) => {
            await identity.setTenantRoles(tenantId, editing.id, selected);
            toast('success', `Roles updated for ${editing.displayName}.`);
            setEditing(null);
            await users.reload();
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.displayName} from ${issuerName}?`}
          description="They lose every role in this issuer immediately. Their account and access to other issuers are unaffected."
          confirmLabel="Remove access"
          tone="danger"
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await identity.removeTenantUser(tenantId, removing.id);
            toast('success', `${removing.displayName} no longer has access to ${issuerName}.`);
            setRemoving(null);
            await users.reload();
          }}
        />
      )}
      {toggling && (
        <ConfirmDialog
          title={`${toggling.status === 'disabled' ? 'Enable' : 'Disable'} ${toggling.displayName}?`}
          description={
            toggling.status === 'disabled'
              ? 'They will be able to sign in again with their existing roles.'
              : 'They are signed out everywhere and cannot sign in until enabled. Their roles are kept.'
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
            toast(
              'success',
              `${toggling.displayName} ${toggling.status === 'disabled' ? 'enabled' : 'disabled'}.`,
            );
            setToggling(null);
            await users.reload();
          }}
        />
      )}
    </div>
  );
}

export function InviteDialog({
  title,
  roles,
  scope,
  onClose,
  onSubmit,
}: {
  title: string;
  roles: Role[];
  scope: 'platform' | 'tenant';
  onClose: () => void;
  onSubmit: (body: { email: string; displayName: string; roles: string[] }) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const valid =
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) &&
    displayName.trim().length > 0 &&
    selected.length > 0;
  return (
    <Dialog
      title={title}
      description="ATLAS never handles passwords: the identity provider emails an invitation to set one."
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!valid}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onSubmit({
                  email: email.trim().toLowerCase(),
                  displayName: displayName.trim(),
                  roles: selected,
                });
              } catch (failure) {
                setError(failure);
                setBusy(false);
              }
            }}
          >
            Send invitation
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Email">
          {(id) => (
            <TextInput
              id={id}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="off"
            />
          )}
        </Field>
        <Field label="Name">
          {(id) => (
            <TextInput
              id={id}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          )}
        </Field>
      </div>
      <div>
        <p className="mb-2 text-sm font-medium text-ink">Roles</p>
        <RoleChecklist roles={roles} scope={scope} selected={selected} onChange={setSelected} />
      </div>
      {error !== null && <ErrorState error={error} />}
    </Dialog>
  );
}

export function RolesDialog({
  title,
  roles,
  scope,
  initial,
  requireOne = false,
  onClose,
  onSubmit,
}: {
  title: string;
  roles: Role[];
  scope: 'platform' | 'tenant';
  initial: string[];
  requireOne?: boolean;
  onClose: () => void;
  onSubmit: (roles: string[]) => Promise<void>;
}) {
  const [selected, setSelected] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const changed = [...selected].sort().join() !== [...initial].sort().join();
  return (
    <Dialog
      title={title}
      description="Role changes take effect within seconds and are recorded in the audit trail."
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!changed || (requireOne && selected.length === 0)}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onSubmit(selected);
              } catch (failure) {
                setError(failure);
                setBusy(false);
              }
            }}
          >
            Save roles
          </Button>
        </>
      }
    >
      <RoleChecklist roles={roles} scope={scope} selected={selected} onChange={setSelected} />
      {error !== null && <ErrorState error={error} />}
    </Dialog>
  );
}
