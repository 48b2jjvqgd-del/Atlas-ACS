import { Link, useSearchParams } from 'react-router';
import { Centered } from '../components/SessionGate';
import { Button } from '../components/ui';

const reasons: Record<string, string> = {
  'no-account':
    'You signed in successfully, but there is no ATLAS account for you. Ask an administrator for access.',
  'account-disabled': 'Your ATLAS account is disabled. Contact your administrator.',
  'state-mismatch': 'The sign-in could not be verified. Please try again from this browser.',
  'sign-in-expired': 'The sign-in took too long. Please try again.',
  access_denied: 'Sign-in was cancelled.',
};

export function SignedOutPage() {
  const [params] = useSearchParams();
  const reason = params.get('reason');
  return (
    <Centered>
      <h1 className="text-xl font-semibold text-ink">
        {reason ? 'Sign-in not completed' : 'You have signed out'}
      </h1>
      <p className="mt-2 text-sm text-ink-muted" data-testid="signed-out-message">
        {reason
          ? (reasons[reason] ?? 'Sign-in could not be completed. Please try again.')
          : 'Your ATLAS session has ended.'}
      </p>
      <Link to="/">
        <Button variant="primary" className="mt-6 w-full">
          Return to sign in
        </Button>
      </Link>
    </Centered>
  );
}
