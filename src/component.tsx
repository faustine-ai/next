'use client';

import { useEffect } from 'react';
import Faustine from '@faustine-ai/web-agent';

/**
 * Mounts the Web Agent once, from the root layout:
 *
 *   <FaustineAgent agentId="wa_…" identityJwt={jwt} />
 *
 * `identityJwt` comes from a Server Component that called
 * `faustineIdentityToken(user)` — the secret stays on the server. Strict
 * Mode's double effect is safe: `init()` returns the existing instance.
 */
export interface FaustineAgentProps {
  agentId: string;
  /** Faustine environment to serve (default Production). */
  env?: string;
  /** Verified identity, signed on the server. Null / undefined = anonymous. */
  identityJwt?: string | null;
  /** @internal Faustine's own test clusters. Apps never set it: the component knows where Faustine is. */
  apiBase?: string;
  /** Debug mode: the page opens a live debug session for the portal's Tests tab. Dev/staging only. */
  debug?: boolean;
}

export function FaustineAgent({ agentId, env, identityJwt, apiBase, debug }: FaustineAgentProps) {
  useEffect(() => {
    const agent = Faustine.init({ agentId, ...(env ? { env } : {}), ...(apiBase ? { apiBase } : {}), ...(debug ? { debug: true } : {}) });
    if (identityJwt) agent.identify({ jwt: identityJwt });
  }, [agentId, env, identityJwt, apiBase, debug]);
  return null;
}
