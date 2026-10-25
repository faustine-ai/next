import { authError, networkError, upstreamError, usageError } from './errors';

/**
 * The three adapter endpoints of the sdk-service, reachable with a setup code
 * (once) and then with the adapter token it returns — scoped to one Web
 * Agent: read the surface map, report the registry, read the adapter status.
 * No Faustine account on this machine.
 */
export const DEFAULT_API_BASE = 'https://api.faustine.ai/sdk/api';

export type SurfaceKind = 'server-action' | 'data-layer' | 'route-handler' | 'client-fetch' | 'inline-rsc-read';

export interface SurfaceOperation {
  /** Faustine's name for it: `module.action`. */
  operation: string;
  kind: SurfaceKind;
  file: string;
  symbol: string;
  description: string;
  suggestion?: string;
}

export interface SurfaceResponse {
  webAgent: string;
  formatVersion: number;
  analysedAt: string | null;
  operations: SurfaceOperation[];
}

export type AdapterGap =
  | { kind: 'registry_incomplete'; missing: string[]; noRegistry: boolean }
  | { kind: 'repo_ahead_of_deploy'; repoHash: string; deployedHash: string }
  | { kind: 'stale_binding'; broken: { operation: string; reason: string }[] };

export interface AdapterStatus {
  webAgent: string;
  /** What `init` / `sync` last reported from a machine. */
  registry: { hash: string; formatVersion: number; operations: string[]; seen?: string[] | null; reportedAt: string } | null;
  /** I3: the registry as the last pushed / uploaded commit carried it (Faustine's push check). */
  repo?: { sha: string; found: boolean; hash: string | null; operations: string[]; broken: { operation: string; reason: string }[]; checkedAt: string } | null;
  deployed: { hash: string; buildSha: string | null; at: string } | null;
  /** I3: generated · in_repo · deployed, how much of the surface the registry binds, what is missing. */
  state?: 'none' | 'generated' | 'in_repo' | 'deployed';
  binds?: { bound: number; total: number };
  gaps?: AdapterGap[];
  /** Operations the served version enables (what the handler will accept). */
  enabled: string[];
}

export interface SetupResponse {
  token: string;
  webAgent: string;
}

export class AdapterClient {
  constructor(
    private readonly apiBase: string,
    private readonly token: string | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    if (auth && !this.token) throw authError('No adapter token — run `faustine-next init --setup <code>` with a code from the portal.');
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiBase.replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(auth && this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw networkError(`Could not reach Faustine at ${this.apiBase}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { message: text.slice(0, 200) };
    }
    if (res.ok) return parsed as T;
    const msg = (parsed as { message?: string; error?: string })?.message ?? (parsed as { error?: string })?.error ?? `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) throw authError(String(msg), res.status === 403 ? 'forbidden' : 'unauthorized');
    if (res.status === 400 || res.status === 404 || res.status === 410 || res.status === 422) throw usageError(String(msg));
    throw upstreamError(`Faustine answered ${res.status}: ${String(msg)}`);
  }

  /** Exchange a one-time setup code for the adapter token. */
  setup(code: string): Promise<SetupResponse> {
    return this.call<SetupResponse>('POST', '/adapter/setup', { code }, false);
  }

  surface(): Promise<SurfaceResponse> {
    return this.call<SurfaceResponse>('GET', '/adapter/surface');
  }

  reportRegistry(report: { registryHash: string; formatVersion: number; operations: string[]; seen: string[]; source: 'init' | 'sync' }): Promise<{ ok: true }> {
    return this.call<{ ok: true }>('POST', '/adapter/registry', report);
  }

  status(): Promise<AdapterStatus> {
    return this.call<AdapterStatus>('GET', '/adapter/status');
  }
}
