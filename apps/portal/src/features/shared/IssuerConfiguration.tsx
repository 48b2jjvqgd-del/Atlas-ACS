import {
  issuerSettingsSchema,
  type IssuerSettings,
  type TenantConfiguration,
} from '@atlas/contracts';
import { useState } from 'react';
import { Card } from '../../components/Card';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  ErrorState,
  Field,
  KeyValues,
  Select,
  SkeletonRows,
  TextInput,
  formatDateTime,
  useToast,
} from '../../components/ui';
import { issuers } from '../../lib/endpoints';
import { useSession } from '../../lib/session';
import { useResource } from '../../lib/use-api';

const timezones = [
  'Europe/London',
  'Europe/Dublin',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Warsaw',
  'UTC',
];
const locales = ['en-GB', 'en-IE', 'fr-FR', 'de-DE', 'es-ES', 'pl-PL'];

/**
 * Issuer configuration: the current version, read-only without issuer.configuration.manage.
 * Saving creates a new immutable version; a concurrent change by someone else is detected
 * (optimistic concurrency) and reported instead of silently overwritten.
 */
export function IssuerConfiguration({
  tenantId,
  readOnlyReason,
}: {
  tenantId: string;
  readOnlyReason?: string;
}) {
  const { can } = useSession();
  const toast = useToast();
  const editable = can('issuer.configuration.manage', tenantId) && !readOnlyReason;
  const { state, reload } = useResource(`configuration:${tenantId}`, (signal) =>
    issuers.configuration(tenantId, signal),
  );
  // The draft belongs to the version it was started from; a newer version replaces it.
  const [draft, setDraftState] = useState<{ version: number; settings: IssuerSettings } | null>(
    null,
  );
  const [confirming, setConfirming] = useState(false);

  if (state.status === 'loading') return <SkeletonRows rows={5} />;
  if (state.status === 'error')
    return <ErrorState error={state.error} onRetry={() => void reload()} />;
  const current: TenantConfiguration = state.data;
  const settings = draft && draft.version === current.version ? draft.settings : current.settings;
  const setDraft = (next: IssuerSettings) =>
    setDraftState({ version: current.version, settings: next });
  const parsed = issuerSettingsSchema.safeParse(settings);
  const changed = JSON.stringify(settings) !== JSON.stringify(current.settings);
  const set = (patch: Partial<IssuerSettings>) => setDraft({ ...settings, ...patch });
  const issue = (field: string) =>
    parsed.success
      ? undefined
      : parsed.error.issues.find((i) => i.path.join('.') === field)?.message;

  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card
        title="Configuration"
        description={
          editable
            ? 'Changes create a new version and are audited.'
            : (readOnlyReason ?? 'You can view but not change this configuration.')
        }
        className="xl:col-span-2"
        actions={
          editable && (
            <div className="flex gap-2">
              <Button
                variant="ghost"
                disabled={!changed}
                onClick={() => setDraft(current.settings)}
              >
                Discard
              </Button>
              <Button
                variant="primary"
                disabled={!changed || !parsed.success}
                onClick={() => setConfirming(true)}
              >
                Save changes
              </Button>
            </div>
          )
        }
      >
        <fieldset disabled={!editable} className="grid gap-5 sm:grid-cols-2">
          <Field label="Time zone">
            {(id) => (
              <Select
                id={id}
                value={settings.timezone}
                onChange={(e) => set({ timezone: e.target.value })}
              >
                {[...new Set([settings.timezone, ...timezones])].map((zone) => (
                  <option key={zone}>{zone}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Default locale">
            {(id) => (
              <Select
                id={id}
                value={settings.defaultLocale}
                onChange={(e) => set({ defaultLocale: e.target.value })}
              >
                {[...new Set([settings.defaultLocale, ...locales])].map((locale) => (
                  <option key={locale}>{locale}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Cardholder support email" error={issue('supportContactEmail')}>
            {(id, describedBy) => (
              <TextInput
                id={id}
                aria-describedby={describedBy}
                aria-invalid={Boolean(issue('supportContactEmail'))}
                value={settings.supportContactEmail ?? ''}
                onChange={(e) => set({ supportContactEmail: e.target.value.trim() || null })}
                placeholder="support@issuer.test"
              />
            )}
          </Field>
          <Field label="Cardholder support phone" error={issue('supportContactPhone')}>
            {(id, describedBy) => (
              <TextInput
                id={id}
                aria-describedby={describedBy}
                aria-invalid={Boolean(issue('supportContactPhone'))}
                value={settings.supportContactPhone ?? ''}
                onChange={(e) => set({ supportContactPhone: e.target.value.trim() || null })}
                placeholder="+44 20 7946 0000"
              />
            )}
          </Field>
          <Field
            label="Brand colour"
            error={issue('branding.primaryColour')}
            hint="Used on cardholder challenge pages (Stage 3)."
          >
            {(id, describedBy) => (
              <div className="flex items-center gap-3">
                <span
                  className="size-9 shrink-0 rounded-lg ring-1 ring-line-strong"
                  style={{
                    background: parsed.success ? settings.branding.primaryColour : 'transparent',
                  }}
                />
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  value={settings.branding.primaryColour}
                  onChange={(e) => set({ branding: { primaryColour: e.target.value } })}
                />
              </div>
            )}
          </Field>
          <div>
            <p className="mb-1.5 text-sm font-medium text-ink">Scheme participation</p>
            <p className="mb-2 text-xs text-ink-subtle">
              Simulated directory servers only. No live scheme connectivity.
            </p>
            <Checkbox
              label="Visa Secure"
              checked={settings.schemeParticipation.visa}
              onChange={(e) =>
                set({
                  schemeParticipation: { ...settings.schemeParticipation, visa: e.target.checked },
                })
              }
            />
            <Checkbox
              label="Mastercard Identity Check"
              checked={settings.schemeParticipation.mastercard}
              onChange={(e) =>
                set({
                  schemeParticipation: {
                    ...settings.schemeParticipation,
                    mastercard: e.target.checked,
                  },
                })
              }
            />
          </div>
        </fieldset>
      </Card>
      <Card title="Version">
        <KeyValues
          items={[
            {
              label: 'Current version',
              value: <span data-testid="configuration-version">{current.version}</span>,
            },
            { label: 'Saved', value: formatDateTime(current.createdAt) },
          ]}
        />
        <p className="mt-4 text-xs leading-5 text-ink-subtle">
          Versions are immutable. BIN ranges (synthetic test ranges only) are configured from Stage
          1B.
        </p>
      </Card>
      {confirming && (
        <ConfirmDialog
          title="Save configuration?"
          description={`This creates version ${current.version + 1}. Every changed field is recorded in the audit trail with its previous value.`}
          confirmLabel="Save version"
          onClose={() => setConfirming(false)}
          onConfirm={async () => {
            await issuers.saveConfiguration(
              tenantId,
              current.version,
              parsed.success ? parsed.data : settings,
            );
            toast('success', `Configuration saved as version ${current.version + 1}.`);
            setConfirming(false);
            await reload();
          }}
        />
      )}
    </div>
  );
}
