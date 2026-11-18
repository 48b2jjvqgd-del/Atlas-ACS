import type { TenantStatus } from '@atlas/contracts';
import { StatusPill } from '../../components/StatusPill';

const tone = {
  onboarding: 'accent',
  active: 'ok',
  suspended: 'warn',
  offboarded: 'neutral',
} as const;
const label = {
  onboarding: 'Onboarding',
  active: 'Active',
  suspended: 'Suspended',
  offboarded: 'Offboarded',
} as const;

export function IssuerStatus({ status }: { status: TenantStatus }) {
  return <StatusPill tone={tone[status]}>{label[status]}</StatusPill>;
}

export function UserStatus({ status }: { status: 'invited' | 'active' | 'disabled' }) {
  const tones = { invited: 'accent', active: 'ok', disabled: 'neutral' } as const;
  const labels = { invited: 'Invited', active: 'Active', disabled: 'Disabled' } as const;
  return <StatusPill tone={tones[status]}>{labels[status]}</StatusPill>;
}
