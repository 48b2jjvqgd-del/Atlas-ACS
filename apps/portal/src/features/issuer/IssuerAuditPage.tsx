import { Card } from '../../components/Card';
import { AuditTrail } from '../shared/AuditTrail';
import { IssuerWorkspace } from './IssuerWorkspace';

export function IssuerAuditPage() {
  return (
    <IssuerWorkspace
      title="Audit history"
      description="Every change to your issuer, its configuration and its users, and every denied attempt by your users."
    >
      {(tenant) => (
        <Card>
          <AuditTrail source={{ kind: 'tenant', tenantId: tenant.id }} />
        </Card>
      )}
    </IssuerWorkspace>
  );
}
