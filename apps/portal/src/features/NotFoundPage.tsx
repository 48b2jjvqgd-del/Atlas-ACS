import { Link } from 'react-router';
import { PageHeader } from '../components/PageHeader';

export function NotFoundPage() {
  return (
    <>
      <PageHeader
        title="Page not found"
        description="This page does not exist in the ATLAS portal."
      />
      <Link to="/" className="text-sm text-accent-strong hover:underline">
        Return to the dashboard
      </Link>
    </>
  );
}
