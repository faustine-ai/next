import { normalizeParams, type OperationFn, type OperationName, type OperationParam, type OperationSchema, type Registry } from './registry';

/**
 * The catch-all route handler the customer mounts at
 * `app/api/faustine/[...op]/route.ts`:
 *
 *   export const { GET, POST } = createFaustineHandler(registry)
 *
 * GET  /api/faustine/manifest  → what this build serves (names, hash, SHA)
 * POST /api/faustine/<op>      → runs the bound function with the JSON body
 *
 * It runs inside the app's own request scope — `cookies()`, `headers()`,
 * `revalidatePath()` work in the bound function as they do in a Server
 * Action — and it exposes only the operations present BOTH in the registry
 * and in the Web Agent's served manifest (fetched from Faustine, cached by
 * ETag). When Faustine cannot be reached it exposes nothing: the app's own UI
 * is unaffected, the agent gets a clear error.
 */

export interface FaustineHandlerOptions {
  /** @internal Faustine's own test clusters. Apps never set it: the handler knows where Faustine is. */
  apiBase?: string;
  /** The environment whose served version drives the manifest (default `Production`). */
  env?: string;
  /** How long a fetched manifest is reused before revalidating (ms, default 60 000). */
  manifestTtlMs?: number;
  /** The commit this build runs; default from the platform's env (Vercel, GitHub Actions, `FAUSTINE_BUILD_SHA`). */
  buildSha?: string | null;
  /** Override the fetch used for the manifest (tests). */
  fetch?: typeof fetch;
  /** Called once per operation run with the outcome; for the app's own logging. */
  onRun?: (info: { operation: OperationName; ok: boolean; ms: number; status: number }) => void;
}

/** What Faustine serves for the Web Agent: which operations the agent may call. */
export interface ServedManifest {
  webAgent: string;
  operations: { op: string; destructive?: boolean }[];
}

export interface ManifestResponse {
  webAgent: string;
  formatVersion: number;
  registryHash: string;
  buildSha: string | null;
  /** Operations bound in this build (the registry). */
  operations: { op: OperationName; schema: boolean; confirm: boolean }[];
  /** Operations the agent can call right now (registry ∩ served manifest); null when Faustine was unreachable. */
  enabled: OperationName[] | null;
  served: 'ok' | 'unreachable' | 'none';
}

type RouteContext = { params: Promise<{ op?: string[] }> | { op?: string[] } };

const DEFAULT_API_BASE = 'https://webagent.faustine.ai';

export function detectBuildSha(env: Record<string, string | undefined> = process.env): string | null {
  return (
    env.FAUSTINE_BUILD_SHA ||
    env.VERCEL_GIT_COMMIT_SHA ||
    env.GITHUB_SHA ||
    env.CF_PAGES_COMMIT_SHA ||
    env.COMMIT_REF ||
    env.SOURCE_VERSION ||
    null
  );
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

/**
 * The same Origin-vs-Host rule Next.js applies to Server Actions: a request
 * that names an Origin must name this host. Same-origin fetches from the
 * generated SDK always do; a page on another site cannot drive the handler.
 */
export function originAllowed(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true; // same-origin GET / server-to-server: no Origin header
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.split(',')[0].trim().toLowerCase();
  } catch {
    return false;
  }
}

/** The JSON input as an object of fields, for a `FormData` parameter: arrays repeat the field, objects are JSON strings. */
export function toFormData(input: unknown): FormData {
  const fd = new FormData();
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fd;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) fd.append(key, typeof item === 'object' ? JSON.stringify(item) : String(item));
  }
  return fd;
}

/** The arguments of the call for this input, by the registry line's `params` (see `OperationParam`). */
export function argumentsFor(params: OperationParam[] | undefined, input: unknown): unknown[] {
  const list = normalizeParams(params);
  if (!list) return [input];
  const sent = list.filter((p) => p.kind !== 'prevState');
  if (sent.length === 0) return list.map(() => undefined);
  const single = sent.length === 1;
  const record = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  return list.map((p) => {
    if (p.kind === 'prevState') return undefined;
    // A FormData parameter is always built from the whole input's fields.
    if (p.kind === 'formData') return toFormData(input);
    if (!single) return record[p.name];
    // One value parameter: the body is the argument; `{ <name>: v }` alone is unwrapped (what a generated SDK tends to send).
    const keys = Object.keys(record);
    return keys.length === 1 && keys[0] === p.name && input === record ? record[p.name] : input;
  });
}

export async function callOperation(fn: OperationFn, params: OperationParam[] | undefined, input: unknown): Promise<unknown> {
  return await (fn as (...args: unknown[]) => unknown)(...argumentsFor(params, input));
}

/** `redirect()` and `notFound()` throw errors Next.js recognises by `digest`; we hand them back as data. */
export function structuredNextError(err: unknown): { kind: 'redirect'; url: string; permanent: boolean } | { kind: 'notFound' } | null {
  const digest = (err as { digest?: unknown })?.digest;
  if (typeof digest !== 'string') return null;
  if (digest.startsWith('NEXT_REDIRECT')) {
    // NEXT_REDIRECT;<type>;<url>;<status>;
    const parts = digest.split(';');
    return { kind: 'redirect', url: parts[2] ?? '', permanent: parts[3] === '308' };
  }
  if (digest === 'NEXT_NOT_FOUND' || digest.startsWith('NEXT_HTTP_ERROR_FALLBACK;404')) {
    return { kind: 'notFound' };
  }
  return null;
}

async function validate(schema: OperationSchema, input: unknown): Promise<{ ok: true; data: unknown } | { ok: false; issues: unknown }> {
  try {
    if (typeof schema === 'function') return { ok: true, data: schema(input) };
    if ('safeParse' in schema) {
      const r = schema.safeParse(input);
      return r.success ? { ok: true, data: r.data } : { ok: false, issues: (r as { error: unknown }).error };
    }
    return { ok: true, data: schema.parse(input) };
  } catch (e) {
    return { ok: false, issues: e instanceof Error ? e.message : e };
  }
}

/** Fetches the served manifest with an ETag cache; `null` when Faustine is unreachable. */
export class ManifestClient {
  private etag: string | null = null;
  private cached: ServedManifest | null = null;
  private fetchedAt = 0;
  private inflight: Promise<ServedManifest | null> | null = null;

  constructor(
    private readonly url: string,
    private readonly ttlMs: number,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async get(): Promise<ServedManifest | null> {
    if (this.cached && Date.now() - this.fetchedAt < this.ttlMs) return this.cached;
    if (this.inflight) return this.inflight;
    this.inflight = this.revalidate().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async revalidate(): Promise<ServedManifest | null> {
    try {
      const res = await this.fetchImpl(this.url, {
        headers: this.etag ? { 'if-none-match': this.etag } : {},
        cache: 'no-store',
      } as RequestInit);
      if (res.status === 304 && this.cached) {
        this.fetchedAt = Date.now();
        return this.cached;
      }
      if (!res.ok) return this.cached && Date.now() - this.fetchedAt < this.ttlMs * 10 ? this.cached : null;
      const body = (await res.json()) as ServedManifest;
      this.cached = body;
      this.etag = res.headers.get('etag');
      this.fetchedAt = Date.now();
      return body;
    } catch {
      // Fail closed: a stale manifest is reused briefly, then nothing is exposed.
      return this.cached && Date.now() - this.fetchedAt < this.ttlMs * 10 ? this.cached : null;
    }
  }
}

export function createFaustineHandler(registry: Registry, opts: FaustineHandlerOptions = {}) {
  const apiBase = (opts.apiBase ?? process.env.FAUSTINE_API_BASE ?? DEFAULT_API_BASE).replace(/\/$/, '');
  const env = opts.env ?? process.env.FAUSTINE_ENV ?? 'Production';
  const buildSha = opts.buildSha === undefined ? detectBuildSha() : opts.buildSha;
  // The registry hash and the build SHA ride along: that is how the portal
  // learns what a running deployment serves (the gateway relays them).
  const manifestUrl =
    `${apiBase}/adapter-manifest?wid=${encodeURIComponent(registry.webAgent)}&env=${encodeURIComponent(env)}` +
    `&registry=${encodeURIComponent(registry.hash)}${buildSha ? `&build=${encodeURIComponent(buildSha)}` : ''}`;
  const manifests = new ManifestClient(manifestUrl, opts.manifestTtlMs ?? 60_000, opts.fetch ?? fetch);
  const headers = { 'x-faustine-registry': registry.hash, ...(buildSha ? { 'x-faustine-build': buildSha } : {}) };

  async function opOf(ctx: RouteContext): Promise<string> {
    const params = await ctx.params;
    return (params.op ?? []).join('/');
  }

  async function enabledOps(): Promise<{ served: ManifestResponse['served']; enabled: OperationName[] | null }> {
    const served = await manifests.get();
    if (!served) return { served: 'unreachable', enabled: null };
    const names = new Set(served.operations.map((o) => o.op));
    const enabled = registry.operations.filter((op) => names.has(op));
    return { served: served.operations.length === 0 ? 'none' : 'ok', enabled };
  }

  async function GET(req: Request, ctx: RouteContext): Promise<Response> {
    const op = await opOf(ctx);
    if (op !== 'manifest') return json({ error: 'not_found', message: `GET /api/faustine/${op} — only /manifest answers GET.` }, 404, headers);
    const { served, enabled } = await enabledOps();
    const body: ManifestResponse = {
      webAgent: registry.webAgent,
      formatVersion: registry.formatVersion,
      registryHash: registry.hash,
      buildSha,
      operations: registry.operations.map((name) => ({
        op: name,
        schema: Boolean(registry.bindings[name].schema),
        confirm: Boolean(registry.bindings[name].confirm),
      })),
      enabled,
      served,
    };
    return json(body, 200, headers);
  }

  async function POST(req: Request, ctx: RouteContext): Promise<Response> {
    const started = Date.now();
    const op = await opOf(ctx);
    const done = (status: number, body: unknown) => {
      opts.onRun?.({ operation: op as OperationName, ok: status < 400, ms: Date.now() - started, status });
      return json(body, status, headers);
    };
    if (!originAllowed(req)) return done(403, { error: 'origin', message: 'Origin does not match this host.' });
    const binding = registry.bindings[op as OperationName];
    if (!binding) return done(404, { error: 'unknown_operation', message: `"${op}" is not in this app's Faustine registry.` });

    const { served, enabled } = await enabledOps();
    if (enabled === null) {
      return done(503, { error: 'manifest_unavailable', message: 'Faustine could not be reached to confirm which operations are enabled; nothing is exposed.' });
    }
    if (!enabled.includes(op as OperationName)) {
      return done(403, {
        error: 'operation_disabled',
        message: served === 'none' ? `No operations are enabled for Web Agent ${registry.webAgent} yet.` : `"${op}" is not enabled for this Web Agent.`,
      });
    }

    let input: unknown = {};
    const raw = await req.text();
    if (raw.trim()) {
      try {
        input = JSON.parse(raw);
      } catch {
        return done(400, { error: 'invalid_json', message: 'The request body must be JSON.' });
      }
    }
    if (binding.schema) {
      const schema = await binding.schema();
      const v = await validate(schema, input);
      if (!v.ok) return done(422, { error: 'invalid_input', message: `Input rejected by the operation's schema.`, issues: v.issues });
      input = v.data;
    }

    try {
      const fn = await binding.fn();
      const result = await callOperation(fn, binding.params, input);
      return done(200, { ok: true, result: result === undefined ? null : result });
    } catch (err) {
      const structured = structuredNextError(err);
      if (structured) return done(200, { ok: true, result: null, ...structured });
      const message = err instanceof Error ? err.message : String(err);
      return done(500, { error: 'operation_failed', message });
    }
  }

  return { GET, POST };
}
