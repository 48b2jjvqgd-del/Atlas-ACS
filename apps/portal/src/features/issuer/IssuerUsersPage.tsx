import { Card } from '../../components/Card';
import { TenantUsers } from '../shared/TenantUsers';
import { IssuerWorkspace } from './IssuerWorkspace';

export function IssuerUsersPage() {
  return (
    <IssuerWorkspace
      title="Users"
      description="People with access to your issuer and the roles they hold."
    >
      {(tenant) => (
        <Card>
          <TenantUsers tenantId={tenant.id} issuerName={tenant.displayName} />
        </Card>
      )}
    </IssuerWorkspace>
  );
}
