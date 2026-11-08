import { createBrowserRouter, RouterProvider, type RouteObject } from 'react-router';
import { AppShell } from '../components/AppShell';
import { DashboardPage } from '../features/home/DashboardPage';
import { IssuerOverviewPage } from '../features/issuer/IssuerOverviewPage';
import { NotFoundPage } from '../features/NotFoundPage';
import { PlannedPage } from '../features/PlannedPage';
import { PlatformOverviewPage } from '../features/platform/PlatformOverviewPage';
import { ServicesPage } from '../features/platform/ServicesPage';
import { SystemHealthPage } from '../features/platform/SystemHealthPage';
import { workspaces } from './navigation';

/** Pages that exist. Every other navigation item renders its explicit "planned" placeholder. */
const livePages: Record<string, () => React.JSX.Element> = {
  'platform-overview': PlatformOverviewPage,
  'platform-services': ServicesPage,
  'platform-health': SystemHealthPage,
  'issuer-overview': IssuerOverviewPage,
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
  {
    element: <AppShell />,
    children: [
      { index: true, element: <DashboardPage /> },
      ...workspaceRoutes,
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
