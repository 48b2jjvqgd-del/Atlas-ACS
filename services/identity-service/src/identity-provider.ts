import { AtlasError } from '@atlas/shared';

/**
 * Identity-provider administration (Keycloak Admin REST API).
 *
 * ATLAS never stores or handles passwords. Inviting a user creates an account at the identity
 * provider and asks it to email the user a link to set a password (and, for platform users, to
 * enrol a second factor). Locally the email lands in Mailpit.
 *
 * identity-service authenticates with its own client-credentials token. Its service account holds
 * only realm-management manage-users, view-users and view-events in the ATLAS realm.
 */
export interface IdentityProviderAdmin {
  /** Creates (or finds, by email) an account. Returns its subject id. */
  ensureUser(user: {
    email: string;
    firstName: string;
    lastName: string;
    requireMfa: boolean;
  }): Promise<string>;
  /** Emails the user the actions to complete their account. Failures are reported, not thrown. */
  sendInvitation(subject: string, requireMfa: boolean): Promise<boolean>;
  setEnabled(subject: string, enabled: boolean): Promise<void>;
  /**
   * Makes sure the account has, or must enrol at next sign-in, a second factor (TOTP). Returns true
   * when enrolment had to be required (the account had no second factor yet). Used when a user is
   * given platform-wide roles after being invited without them.
   */
  requireSecondFactor(subject: string): Promise<boolean>;
  /** Ends every session the user has at the provider. */
  endSessions(subject: string): Promise<void>;
  /** Failed sign-in events since `sinceMs` (epoch ms), oldest first. */
  loginErrors(sinceMs: number): Promise<IdpLoginError[]>;
}

export interface IdpLoginError {
  time: number;
  userId: string | null;
  error: string;
  clientId: string | null;
}

export function createKeycloakAdmin(options: {
  /** Back-channel issuer base, e.g. http://keycloak:8080/realms/atlas */
  issuerBase: string;
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): IdentityProviderAdmin {
  const doFetch = options.fetch ?? fetch;
  const issuer = options.issuerBase.replace(/\/$/, '');
  const match = /^(.*)\/realms\/([^/]+)$/.exec(issuer);
  if (!match) throw new Error('OIDC issuer URL must end in /realms/<realm>');
  const adminBase = `${match[1]}/admin/realms/${match[2]}`;
  const timeout = options.timeoutMs ?? 5_000;
  let cached: { token: string; expiresAt: number } | undefined;

  async function token(): Promise<string> {
    if (cached && cached.expiresAt - 30_000 > Date.now()) return cached.token;
    const response = await call(`${issuer}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: options.clientId,
        client_secret: options.clientSecret,
      }),
    });
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!response.ok || !body.access_token) {
      throw new AtlasError('DEPENDENCY_UNAVAILABLE', {
        detail: 'Identity provider refused credentials',
      });
    }
    cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 60) * 1000 };
    return cached.token;
  }

  async function call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
    } catch (error) {
      throw new AtlasError('DEPENDENCY_UNAVAILABLE', {
        detail: 'Identity provider unreachable',
        cause: error,
      });
    }
  }

  async function admin(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
    const response = await call(`${adminBase}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${await token()}`,
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (response.status === 401 && !retried) {
      // The cached token may predate a signing-key change at the provider: fetch a new one once.
      cached = undefined;
      return admin(path, init, true);
    }
    if (response.status >= 500 || response.status === 401 || response.status === 403) {
      throw new AtlasError('DEPENDENCY_UNAVAILABLE', {
        detail: `Identity provider responded ${response.status}`,
      });
    }
    return response;
  }

  async function findByEmail(email: string): Promise<string | undefined> {
    const response = await admin(`/users?exact=true&email=${encodeURIComponent(email)}`);
    const users = (await response.json()) as { id: string; email?: string }[];
    return users.find((user) => user.email?.toLowerCase() === email)?.id;
  }

  return {
    async ensureUser(user) {
      const existing = await findByEmail(user.email);
      if (existing) return existing;
      const response = await admin('/users', {
        method: 'POST',
        body: JSON.stringify({
          username: user.email,
          email: user.email,
          emailVerified: true,
          firstName: user.firstName,
          lastName: user.lastName,
          enabled: true,
          requiredActions: user.requireMfa
            ? ['UPDATE_PASSWORD', 'CONFIGURE_TOTP']
            : ['UPDATE_PASSWORD'],
        }),
      });
      if (response.status === 409) {
        const found = await findByEmail(user.email);
        if (found) return found;
        throw new AtlasError('CONFLICT', {
          detail: 'An account with this username already exists',
        });
      }
      if (response.status !== 201) {
        throw new AtlasError('DEPENDENCY_UNAVAILABLE', {
          detail: `Account creation failed (${response.status})`,
        });
      }
      const location = response.headers.get('location') ?? '';
      const id = location.slice(location.lastIndexOf('/') + 1);
      if (!/^[0-9a-f-]{36}$/.test(id)) {
        throw new AtlasError('DEPENDENCY_UNAVAILABLE', {
          detail: 'Account creation returned no id',
        });
      }
      return id;
    },
    async sendInvitation(subject, requireMfa) {
      const actions = requireMfa ? ['UPDATE_PASSWORD', 'CONFIGURE_TOTP'] : ['UPDATE_PASSWORD'];
      const response = await admin(
        `/users/${encodeURIComponent(subject)}/execute-actions-email?lifespan=86400`,
        { method: 'PUT', body: JSON.stringify(actions) },
      ).catch(() => undefined);
      return response?.status === 204;
    },
    async setEnabled(subject, enabled) {
      const response = await admin(`/users/${encodeURIComponent(subject)}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      });
      if (response.status !== 204 && response.status !== 404) {
        throw new AtlasError('DEPENDENCY_UNAVAILABLE', {
          detail: `Account update failed (${response.status})`,
        });
      }
    },
    async requireSecondFactor(subject) {
      const path = `/users/${encodeURIComponent(subject)}`;
      const credentials = await admin(`${path}/credentials`);
      if (!credentials.ok) {
        throw new AtlasError('DEPENDENCY_UNAVAILABLE', {
          detail: `Account lookup failed (${credentials.status})`,
        });
      }
      const types = ((await credentials.json()) as { type?: string }[]).map((c) => c.type);
      if (types.includes('otp')) return false;
      const user = await admin(path);
      if (!user.ok) {
        throw new AtlasError('DEPENDENCY_UNAVAILABLE', {
          detail: `Account lookup failed (${user.status})`,
        });
      }
      const current = ((await user.json()) as { requiredActions?: string[] }).requiredActions ?? [];
      if (!current.includes('CONFIGURE_TOTP')) {
        const updated = await admin(path, {
          method: 'PUT',
          body: JSON.stringify({ requiredActions: [...current, 'CONFIGURE_TOTP'] }),
        });
        if (updated.status !== 204) {
          throw new AtlasError('DEPENDENCY_UNAVAILABLE', {
            detail: `Account update failed (${updated.status})`,
          });
        }
      }
      return true;
    },
    async endSessions(subject) {
      await admin(`/users/${encodeURIComponent(subject)}/logout`, { method: 'POST' });
    },
    async loginErrors(sinceMs) {
      const date = new Date(sinceMs).toISOString().slice(0, 10);
      const response = await admin(`/events?type=LOGIN_ERROR&dateFrom=${date}&max=200`);
      if (!response.ok) return [];
      const events = (await response.json()) as {
        time: number;
        userId?: string;
        error?: string;
        clientId?: string;
      }[];
      return events
        .filter((event) => event.time > sinceMs)
        .map((event) => ({
          time: event.time,
          userId: event.userId ?? null,
          error: (event.error ?? 'unknown').slice(0, 64),
          clientId: event.clientId ?? null,
        }))
        .sort((a, b) => a.time - b.time);
    },
  };
}

/** Splits a display name into first and last names for the identity provider. */
export function splitName(displayName: string): { firstName: string; lastName: string } {
  const parts = displayName.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0]!, lastName: '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1)! };
}
