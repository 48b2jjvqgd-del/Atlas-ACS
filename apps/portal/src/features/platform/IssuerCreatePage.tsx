import { createTenantBodySchema } from '@atlas/contracts';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Card } from '../../components/Card';
import { PageHeader } from '../../components/PageHeader';
import { Button, ErrorState, Field, TextInput, useToast } from '../../components/ui';
import { ApiError } from '../../lib/api';
import { issuers } from '../../lib/endpoints';

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 63);

export function IssuerCreatePage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [displayName, setDisplayName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [internalReference, setInternalReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [submitted, setSubmitted] = useState(false);

  const body = {
    displayName,
    slug: slugTouched ? slug : slugify(displayName),
    internalReference: internalReference.toUpperCase(),
  };
  const parsed = createTenantBodySchema.safeParse(body);
  const fieldError = (name: string) => {
    if (error instanceof ApiError) {
      const issue = error.issues?.find((i) => i.path.endsWith(name));
      if (issue) return issue.message;
    }
    if (!submitted || parsed.success) return undefined;
    return parsed.error.issues.find((i) => i.path[0] === name)?.message;
  };

  return (
    <>
      <PageHeader
        eyebrow="Platform · Issuers"
        title="Register an issuer"
        description="The issuer starts in onboarding. Activate it once its configuration and administrators are in place. Use synthetic names and references only."
      />
      <Card className="max-w-2xl">
        <form
          className="space-y-5"
          noValidate
          onSubmit={async (event) => {
            event.preventDefault();
            setSubmitted(true);
            if (!parsed.success) return;
            setBusy(true);
            setError(null);
            try {
              const created = await issuers.create(parsed.data);
              toast('success', `${created.displayName} registered.`);
              navigate(`/platform/issuers/${created.id}`);
            } catch (failure) {
              setError(failure);
              setBusy(false);
            }
          }}
        >
          <Field label="Issuer name" error={fieldError('displayName')}>
            {(id, describedBy) => (
              <TextInput
                id={id}
                aria-describedby={describedBy}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Example Synthetic Bank"
              />
            )}
          </Field>
          <Field
            label="Slug"
            hint="Lowercase letters, digits and hyphens. Used in URLs; never for access decisions."
            error={fieldError('slug')}
          >
            {(id, describedBy) => (
              <TextInput
                id={id}
                aria-describedby={describedBy}
                value={slugTouched ? slug : slugify(displayName)}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value);
                }}
              />
            )}
          </Field>
          <Field
            label="Internal reference"
            hint="Unique operator reference, e.g. EXB-0001."
            error={fieldError('internalReference')}
          >
            {(id, describedBy) => (
              <TextInput
                id={id}
                aria-describedby={describedBy}
                value={internalReference}
                onChange={(e) => setInternalReference(e.target.value.toUpperCase())}
              />
            )}
          </Field>
          {error !== null && <ErrorState error={error} />}
          <div className="flex justify-end gap-2 border-t border-line pt-5">
            <Link to="/platform/issuers">
              <Button variant="ghost">Cancel</Button>
            </Link>
            <Button type="submit" variant="primary" busy={busy}>
              Register issuer
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}
