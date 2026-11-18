import { createBrowserRouter, RouterProvider, type RouteObject } from 'react-router';
import { AppShell } from '../components/AppShell';
import { ToastProvider } from '../components/ui';
import { AccountPage } from '../features/account/AccountPage';
import { DashboardPage } from '../features/home/DashboardPage';
import { IssuerAuditPage } from '../features/issuer/IssuerAuditPage';
import { IssuerConfigurationPage } from '../features/issuer/IssuerConfigurationPage';
import { IssuerOverviewPage } from '../features/issuer/IssuerOverviewPage';
import { IssuerUsersPage } from '../features/issuer/IssuerUsersPage';
import { NotFoundPage } from '../features/NotFoundPage';
import { PlannedPage } from '../features/PlannedPage';
import { AuditExplorerPage } from '../features/platform/AuditExplorerPage';
import { IssuerCreatePage } from '../features/platform/IssuerCreatePage';
import { IssuerDetailPage } from '../features/platform/IssuerDetailPage';
import { IssuersPage } from '../features/platform/IssuersPage';
import { PlatformOverviewPage } from '../features/platform/PlatformOverviewPage';
import { PlatformUsersPage } from '../features/platform/PlatformUsersPage';
import { RolesPage } from '../features/platform/RolesPage';
import { ServicesPage } from '../features/platform/ServicesPage';
import { SystemHealthPage } from '../features/platform/SystemHealthPage';
import { SignedOutPage } from '../features/SignedOutPage';
import { SessionProvider } from '../lib/session';
import { TenantProvider } from '../lib/tenant';
import { workspaces } from './navigation';

/** Pages that exist. Every other navigation item renders its explicit "planned" placeholder. */
const livePages: Record<string, () => React.JSX.Element | null> = {
  'platform-overview': PlatformOverviewPage,
  'platform-issuers': IssuersPage,
  'platform-users': PlatformUsersPage,
  'platform-roles': RolesPage,
  'platform-audit': AuditExplorerPage,
  'platform-services': ServicesPage,
  'platform-health': SystemHealthPage,
  'issuer-overview': IssuerOverviewPage,
  'issuer-configuration': IssuerConfigurationPage,
  'issuer-users': IssuerUsersPage,
  'issuer-audit': IssuerAuditPage,
};

const workspaceRoutes: RouteObject[] = workspaces.flatMap((workspace) =>
  workspace.items.map((item) => {
    const Page = livePages[item.id];
    return {
      path: item.path,
      element: Page ? <Page /> : <PlannedPage workspace={workspace} item={item} />,
    };
  }),
);

const router = createBrowserRouter([
  { path: '/signed-out', element: <SignedOutPage /> },
  {
    element: <AppShell />,
    children: [
      { index: true, element: <DashboardPage /> },
      ...workspaceRoutes,
      { path: '/platform/issuers/new', element: <IssuerCreatePage /> },
      { path: '/platform/issuers/:tenantId', element: <IssuerDetailPage /> },
      { path: '/account', element: <AccountPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

export function App() {
  return (
    <SessionProvider>
      <TenantProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </TenantProvider>
    </SessionProvider>
  );
}
