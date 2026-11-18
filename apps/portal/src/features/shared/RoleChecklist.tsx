import type { Role } from '@atlas/contracts';
import { Checkbox } from '../../components/ui';

/** Choose roles of one scope. Each role shows how many permissions it grants. */
export function RoleChecklist({
  roles,
  scope,
  selected,
  onChange,
}: {
  roles: Role[];
  scope: 'platform' | 'tenant';
  selected: string[];
  onChange: (roles: string[]) => void;
}) {
  const options = roles.filter((role) => role.scope === scope);
  return (
    <fieldset className="max-h-72 space-y-0.5 overflow-y-auto rounded-lg border border-line p-2">
      <legend className="sr-only">Roles</legend>
      {options.map((role) => (
        <Checkbox
          key={role.key}
          label={role.name}
          description={`${role.description} · ${role.permissions.length} permissions`}
          checked={selected.includes(role.key)}
          onChange={(event) =>
            onChange(
              event.target.checked
                ? [...selected, role.key]
                : selected.filter((key) => key !== role.key),
            )
          }
        />
      ))}
    </fieldset>
  );
}

export function roleName(roles: Role[] | undefined, key: string): string {
  return roles?.find((role) => role.key === key)?.name ?? key;
}
