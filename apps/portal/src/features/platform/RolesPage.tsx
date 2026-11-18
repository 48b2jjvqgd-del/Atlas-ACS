import { roleKeySchema, type Role } from '@atlas/contracts';
import { Fragment, useMemo, useState } from 'react';
import { Card } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { PageHeader } from '../../components/PageHeader';
import {
  Button,
  Checkbox,
  Dialog,
  ErrorState,
  Field,
  Select,
  SkeletonRows,
  Tabs,
  TextInput,
  useToast,
} from '../../components/ui';
import { identity } from '../../lib/endpoints';
import { useSession } from '../../lib/session';
import { useResource } from '../../lib/use-api';

type PermissionInfo = Awaited<ReturnType<typeof identity.permissions>>[number];

/**
 * Roles and permissions. System roles are defined in code and read-only here; custom roles can be
 * composed from the permission catalogue (platform.roles.manage). Platform-only permissions can
 * never be added to issuer roles — the API enforces this too.
 */
export function RolesPage() {
  const { can } = useSession();
  const toast = useToast();
  const manage = can('platform.roles.manage');
  const roles = useResource('roles', (signal) => identity.roles(signal));
  const permissions = useResource('permissions', (signal) => identity.permissions(signal));
  const [scope, setScope] = useState<'platform' | 'tenant'>('tenant');
  const [editing, setEditing] = useState<Role | 'new' | null>(null);

  const loading = roles.state.status === 'loading' || permissions.state.status === 'loading';
  const error =
    roles.state.status === 'error'
      ? roles.state.error
      : permissions.state.status === 'error'
        ? permissions.state.error
        : null;

  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="Roles and permissions"
        description="Access is granted through granular permissions grouped into roles. Platform roles apply to every issuer; issuer roles apply only within the issuer where they are assigned."
        actions={
          manage && (
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Icon name="plus" className="size-4" /> Custom role
            </Button>
          )
        }
      />
      <Tabs
        tabs={[
          { id: 'tenant', label: 'Issuer roles' },
          { id: 'platform', label: 'Platform roles' },
        ]}
        active={scope}
        onChange={setScope}
      />
      {loading && <SkeletonRows rows={6} />}
      {error && <ErrorState error={error} />}
      {roles.state.status === 'loaded' && permissions.state.status === 'loaded' && (
        <PermissionMatrix
          roles={roles.state.data.filter((role) => role.scope === scope)}
          permissions={permissions.state.data.filter((p) => p.scopes.includes(scope))}
          onEdit={manage ? (role) => setEditing(role) : undefined}
        />
      )}
      {editing && permissions.state.status === 'loaded' && (
        <RoleEditor
          role={editing === 'new' ? null : editing}
          defaultScope={scope}
          permissions={permissions.state.data}
          onClose={() => setEditing(null)}
          onSaved={async (name) => {
            toast('success', `Role ${name} saved.`);
            setEditing(null);
            await roles.reload();
          }}
        />
      )}
    </>
  );
}

function PermissionMatrix({
  roles,
  permissions,
  onEdit,
}: {
  roles: Role[];
  permissions: PermissionInfo[];
  onEdit?: ((role: Role) => void) | undefined;
}) {
  const categories = useMemo(() => [...new Set(permissions.map((p) => p.category))], [permissions]);
  return (
    <Card>
      <div className="overflow-x-auto">
        <table
          className="w-full text-sm"
          style={{ minWidth: 220 + roles.length * 110 }}
          data-testid="permission-matrix"
        >
          <thead>
            <tr>
              <th className="sticky left-0 border-b border-line bg-surface py-3 pr-4 text-left text-xs font-medium uppercase tracking-wider text-ink-subtle">
                Permission
              </th>
              {roles.map((role) => (
                <th
                  key={role.key}
                  className="border-b border-line px-2 py-3 text-center align-bottom text-xs font-medium text-ink"
                >
                  <span className="block">{role.name}</span>
                  <span className="block font-normal text-ink-subtle">
                    {role.isSystem ? 'System' : 'Custom'}
                  </span>
                  {onEdit && !role.isSystem && (
                    <button
                      type="button"
                      className="mt-1 text-accent-strong hover:underline"
                      onClick={() => onEdit(role)}
                    >
                      Edit
                    </button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map((category) => (
              <Fragment key={category}>
                <tr>
                  <td
                    colSpan={roles.length + 1}
                    className="pt-4 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-accent-strong"
                  >
                    {category}
                  </td>
                </tr>
                {permissions
                  .filter((p) => p.category === category)
                  .map((permission) => (
                    <tr key={permission.key} className="border-b border-line/50">
                      <td className="sticky left-0 bg-surface py-2 pr-4">
                        <span className="block font-mono text-[12px] text-ink">
                          {permission.key}
                        </span>
                        <span className="block text-xs text-ink-subtle">
                          {permission.description}
                        </span>
                      </td>
                      {roles.map((role) => (
                        <td key={role.key} className="px-2 py-2 text-center">
                          {role.permissions.includes(permission.key) ? (
                            <Icon name="check" className="mx-auto size-4 text-ok" />
                          ) : (
                            <span className="text-line-strong" aria-label="Not granted">
                              ·
                            </span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function RoleEditor({
  role,
  defaultScope,
  permissions,
  onClose,
  onSaved,
}: {
  role: Role | null;
  defaultScope: 'platform' | 'tenant';
  permissions: PermissionInfo[];
  onClose: () => void;
  onSaved: (name: string) => Promise<void>;
}) {
  const [key, setKey] = useState(role?.key ?? '');
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [scope, setScope] = useState(role?.scope ?? defaultScope);
  const [selected, setSelected] = useState<string[]>(role?.permissions ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const available = permissions.filter((p) => p.scopes.includes(scope));
  const valid =
    name.trim().length >= 2 &&
    selected.length > 0 &&
    (role !== null || roleKeySchema.safeParse(key).success);
  return (
    <Dialog
      title={role ? `Edit ${role.name}` : 'Create a custom role'}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
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
                const permissionsForScope = selected.filter((p) =>
                  available.some((a) => a.key === p),
                );
                if (role)
                  await identity.updateRole(role.key, {
                    name: name.trim(),
                    description: description.trim(),
                    permissions: permissionsForScope,
                  });
                else
                  await identity.createRole({
                    key,
                    name: name.trim(),
                    description: description.trim(),
                    scope,
                    permissions: permissionsForScope,
                  });
                await onSaved(name.trim());
              } catch (failure) {
                setError(failure);
                setBusy(false);
              }
            }}
          >
            Save role
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          {(id) => <TextInput id={id} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Key" hint="Stable identifier, kebab-case.">
          {(id) => (
            <TextInput
              id={id}
              value={key}
              disabled={role !== null}
              onChange={(e) => setKey(e.target.value.toLowerCase())}
            />
          )}
        </Field>
        <Field label="Scope">
          {(id) => (
            <Select
              id={id}
              value={scope}
              disabled={role !== null}
              onChange={(e) => setScope(e.target.value as 'platform' | 'tenant')}
            >
              <option value="tenant">Issuer role</option>
              <option value="platform">Platform role</option>
            </Select>
          )}
        </Field>
        <Field label="Description">
          {(id) => (
            <TextInput
              id={id}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </Field>
      </div>
      <fieldset className="max-h-72 overflow-y-auto rounded-lg border border-line p-2">
        <legend className="sr-only">Permissions</legend>
        {available.map((permission) => (
          <Checkbox
            key={permission.key}
            label={permission.key}
            description={permission.description}
            checked={selected.includes(permission.key)}
            onChange={(e) =>
              setSelected(
                e.target.checked
                  ? [...selected, permission.key]
                  : selected.filter((p) => p !== permission.key),
              )
            }
          />
        ))}
      </fieldset>
      {error !== null && <ErrorState error={error} />}
    </Dialog>
  );
}
