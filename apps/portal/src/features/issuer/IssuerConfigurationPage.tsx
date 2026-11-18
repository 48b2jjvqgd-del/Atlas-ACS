import { IssuerConfiguration } from '../shared/IssuerConfiguration';
import { IssuerWorkspace } from './IssuerWorkspace';

export function IssuerConfigurationPage() {
  return (
    <IssuerWorkspace
      title="Profile and configuration"
      description="Settings that apply to your issuer across ATLAS."
    >
      {(tenant) => (
        <IssuerConfiguration
          tenantId={tenant.id}
          {...(tenant.status === 'offboarded'
            ? { readOnlyReason: 'This issuer has been offboarded.' }
            : {})}
        />
      )}
    </IssuerWorkspace>
  );
}
