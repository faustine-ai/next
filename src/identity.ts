import { createHmac } from 'node:crypto';

/**
 * Signs the identity JWT the widget sends with `agent.identify({ jwt })`
 * (portal → Settings → Identity verification). Server-side only: the secret
 * never reaches the browser. HS256, no dependency — the same claims the docs
 * describe (`sub` required, `name` / `email` optional, short expiry).
 */
export interface IdentityUser {
  id: string;
  name?: string | null;
  email?: string | null;
}

export interface IdentityTokenOptions {
  /** The secret from the portal; default `process.env.FAUSTINE_IDENTITY_SECRET`. */
  secret?: string;
  /** Lifetime in seconds (default 3600). */
  expiresIn?: number;
  /** Clock override (tests). */
  now?: () => number;
}

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function faustineIdentityToken(user: IdentityUser, opts: IdentityTokenOptions = {}): string {
  const secret = opts.secret ?? process.env.FAUSTINE_IDENTITY_SECRET;
  if (!secret) {
    throw new Error('faustineIdentityToken: set FAUSTINE_IDENTITY_SECRET (portal → Settings → Identity verification) or pass `secret`.');
  }
  if (!user || typeof user.id !== 'string' || !user.id) {
    throw new Error('faustineIdentityToken: `user.id` is required.');
  }
  const now = Math.floor((opts.now ?? Date.now)() / 1000);
  const payload: Record<string, unknown> = { sub: user.id, iat: now, exp: now + (opts.expiresIn ?? 3600) };
  if (user.name) payload.name = user.name;
  if (user.email) payload.email = user.email;
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const signature = b64url(createHmac('sha256', secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${signature}`;
}
