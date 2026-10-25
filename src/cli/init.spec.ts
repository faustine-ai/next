import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runInit, syncCheckDrifted } from './init';
import type { SurfaceResponse } from './internal/client';
import { saveAdapterCredential } from './internal/config';

const surface: SurfaceResponse = {
  webAgent: 'wa_e2e',
  formatVersion: 1,
  analysedAt: '2026-10-19T00:00:00Z',
  operations: [
    { operation: 'deals.createDeal', kind: 'server-action', file: 'src/app/deals/actions.ts', symbol: 'createDeal', description: 'Creates a deal' },
    { operation: 'deals.listDeals', kind: 'data-layer', file: 'src/lib/data/deals.ts', symbol: 'listDeals', description: 'Lists deals' },
    { operation: 'deals.get', kind: 'route-handler', file: 'src/app/api/deals/route.ts', symbol: 'GET', description: 'has a URL' },
  ],
};

function fakeApi(lastReported: string[] = [], lastSeen: string[] | null = null) {
  const calls: { method: string; url: string; body: unknown; auth: string | null }[] = [];
  const spent = new Set<string>();
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method: init?.method ?? 'GET', url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.authorization ?? null });
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/adapter/setup')) {
      // Single use, like the real endpoint.
      const code = String((JSON.parse(String(init?.body)) as { code: string }).code);
      if (spent.has(code)) return new Response('{"message":"This setup code was already used"}', { status: 410 });
      spent.add(code);
      return ok({ token: 'adp_secret', webAgent: 'wa_e2e' });
    }
    if (u.endsWith('/adapter/surface')) return headers.authorization === 'Bearer adp_secret' ? ok(surface) : new Response('{"message":"nope"}', { status: 401 });
    if (u.endsWith('/adapter/registry')) return ok({ ok: true });
    if (u.endsWith('/adapter/status')) return ok({ webAgent: 'wa_e2e', registry: lastReported.length ? { hash: 'h', formatVersion: 1, operations: lastReported, seen: lastSeen, reportedAt: 'now' } : null, deployed: null, enabled: [] });
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('faustine-next init', () => {
  let project: string;
  let home: string;
  beforeAll(async () => {
    project = await mkdtemp(join(tmpdir(), 'fn-proj-'));
    home = await mkdtemp(join(tmpdir(), 'fn-home-'));
    process.env.FAUSTINE_CONFIG_DIR = home;
    await mkdir(join(project, 'src', 'app'), { recursive: true });
    await writeFile(join(project, 'tsconfig.json'), '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }');
    await writeFile(join(project, 'AGENTS.md'), '# Acme\n\nBe nice.\n');
    await mkdir(join(project, 'src', 'app', 'deals'), { recursive: true });
    await writeFile(join(project, 'src', 'app', 'deals', 'actions.ts'), "'use server';\nexport async function createDeal(_prev: State, formData: FormData) {}\n");
  });
  afterAll(async () => {
    delete process.env.FAUSTINE_CONFIG_DIR;
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('--dry-run exchanges the code, prints the plan and writes nothing', async () => {
    const { fetchImpl, calls } = fakeApi();
    const r = await runInit({ cwd: project, setup: 'code-1', api: 'https://api.test/sdk', dryRun: true, yes: false, interactive: false, source: 'init', fetchImpl });
    expect(r.webAgent).toBe('wa_e2e');
    expect(r.operations).toEqual(['deals.createDeal', 'deals.listDeals']);
    expect(r.skipped).toEqual([{ operation: 'deals.get', reason: 'already reachable (has a URL)' }]);
    expect(r.files.map((f) => `${f.action} ${f.path}`)).toEqual([
      'create src/faustine/registry.ts',
      'create src/app/api/faustine/[...op]/route.ts',
      'update AGENTS.md',
    ]);
    expect(calls.map((c) => c.method + ' ' + c.url)).toEqual(['POST https://api.test/sdk/adapter/setup', 'GET https://api.test/sdk/adapter/surface']);
    await expect(readFile(join(project, 'src/faustine/registry.ts'))).rejects.toThrow();
    // The token was stored, scoped to the Web Agent.
    const stored = JSON.parse(await readFile(join(home, 'adapters', 'wa_e2e.json'), 'utf-8'));
    expect(stored).toMatchObject({ webAgent: 'wa_e2e', token: 'adp_secret', apiBase: 'https://api.test/sdk' });
  });

  it('a dry-run spends the setup code; the real run with the same code reuses the stored token', async () => {
    const { fetchImpl, calls } = fakeApi();
    const r = await runInit({ cwd: project, setup: 'code-1', dryRun: false, yes: true, interactive: false, source: 'init', fetchImpl });
    expect(r.reported).toBe(true);
    expect(r.credentialFile).toBeNull();
    expect(calls.some((c) => c.url.endsWith('/adapter/setup'))).toBe(false);
    // A code never seen here is exchanged (and, spent, fails the second time).
    const second = fakeApi();
    await runInit({ cwd: project, setup: 'code-2', dryRun: true, yes: true, interactive: false, source: 'init', fetchImpl: second.fetchImpl });
    expect(second.calls.filter((c) => c.url.endsWith('/adapter/setup'))).toHaveLength(1);
    await expect(runInit({ cwd: project, setup: 'code-3', dryRun: true, yes: true, interactive: false, source: 'init', fetchImpl: fakeApi(['x']).fetchImpl }).then(() =>
      runInit({ cwd: project, setup: 'code-3', dryRun: true, yes: true, interactive: false, source: 'init', fetchImpl: fakeApi().fetchImpl }),
    )).resolves.toMatchObject({ webAgent: 'wa_e2e' });
  });

  it('without a TTY it needs --yes; with it, writes the three files and reports the hash', async () => {
    const { fetchImpl, calls } = fakeApi();
    await expect(runInit({ cwd: project, dryRun: false, yes: false, interactive: false, source: 'init', fetchImpl })).rejects.toThrow(/--yes/);
    const r = await runInit({ cwd: project, dryRun: false, yes: true, interactive: false, source: 'init', fetchImpl });
    expect(r.reported).toBe(true);
    const registry = await readFile(join(project, 'src/faustine/registry.ts'), 'utf-8');
    expect(registry).toContain("webAgent: 'wa_e2e'");
    expect(registry).toContain("import('@/app/deals/actions').then((m) => m.createDeal), params: [{ name: '_prev', kind: 'prevState' }, { name: 'formData', kind: 'formData' }] },");
    // No source for listDeals here: no params on its line, the handler passes the input through.
    expect(registry).toContain("m.listDeals) },");
    const route = await readFile(join(project, 'src/app/api/faustine/[...op]/route.ts'), 'utf-8');
    expect(route).toContain("import registry from '@/faustine/registry'");
    const agents = await readFile(join(project, 'AGENTS.md'), 'utf-8');
    expect(agents.startsWith('# Acme\n\nBe nice.')).toBe(true);
    expect(agents).toContain('<!-- BEGIN:faustine -->');
    const report = calls.find((c) => c.url.endsWith('/adapter/registry'));
    expect(report?.body).toEqual({ registryHash: r.registryHash, formatVersion: 1, operations: r.operations, seen: ['deals.createDeal', 'deals.listDeals'], source: 'init' });
    expect(report?.auth).toBe('Bearer adp_secret');
  });

  it('a second run is idempotent (every file unchanged) and finds the token through the registry', async () => {
    const { fetchImpl } = fakeApi();
    const r = await runInit({ cwd: project, dryRun: false, yes: true, interactive: false, source: 'sync', fetchImpl });
    expect(r.files.every((f) => f.action === 'unchanged')).toBe(true);
  });

  it('sync keeps the registry\'s own selection: a removed line stays removed, a new surface operation is added', async () => {
    // The last report named both operations; the developer then removed listDeals from the registry.
    const { fetchImpl } = fakeApi(['deals.createDeal', 'deals.listDeals']);
    const registryPath = join(project, 'src/faustine/registry.ts');
    const trimmed = (await readFile(registryPath, 'utf-8')).split('\n').filter((l) => !l.includes("'deals.listDeals'") && !l.includes('Lists deals')).join('\n');
    await writeFile(registryPath, trimmed);
    const r = await runInit({ cwd: project, dryRun: true, yes: true, interactive: false, source: 'sync', fetchImpl });
    expect(r.operations).toEqual(['deals.createDeal']);
    expect(r.skipped.find((s) => s.operation === 'deals.listDeals')?.reason).toMatch(/removed from the registry/);
    // A brand-new operation (not in the last report) is picked up.
    const { fetchImpl: withNew } = fakeApi(['deals.createDeal']);
    const r2 = await runInit({ cwd: project, dryRun: true, yes: true, interactive: false, source: 'sync', fetchImpl: withNew });
    expect(r2.operations).toEqual(['deals.createDeal', 'deals.listDeals']);
    // One the developer left out at init (`--operations`) was SEEN then: it is not new.
    const { fetchImpl: leftOut } = fakeApi(['deals.createDeal'], ['deals.createDeal', 'deals.listDeals']);
    const r3 = await runInit({ cwd: project, dryRun: true, yes: true, interactive: false, source: 'sync', fetchImpl: leftOut });
    expect(r3.operations).toEqual(['deals.createDeal']);
    // restore for the next tests
    await runInit({ cwd: project, operations: ['deals.createDeal', 'deals.listDeals'], dryRun: false, yes: true, interactive: false, source: 'init', fetchImpl });
  });

  it('sync --check: in step exits 0, drift exits 1, and never writes', async () => {
    const { fetchImpl } = fakeApi(['deals.createDeal', 'deals.listDeals']);
    const inStep = await runInit({ cwd: project, dryRun: true, yes: true, interactive: false, source: 'sync', fetchImpl });
    expect(syncCheckDrifted(inStep)).toBe(false);
    // A new Server Action appears in the surface map: the registry would change.
    surface.operations.push({ operation: 'deals.archiveDeal', kind: 'server-action', file: 'src/app/deals/actions.ts', symbol: 'archiveDeal', description: 'Archives a deal' });
    try {
      const drifted = await runInit({ cwd: project, dryRun: true, yes: true, interactive: false, source: 'sync', fetchImpl });
      expect(syncCheckDrifted(drifted)).toBe(true);
      expect(drifted.files.find((f) => f.path.endsWith('registry.ts'))?.action).toBe('update');
      expect(await readFile(join(project, 'src/faustine/registry.ts'), 'utf-8')).not.toContain('archiveDeal');
    } finally {
      surface.operations.pop();
    }
  });

  it('--operations narrows the registry and rejects unknown names', async () => {
    const { fetchImpl } = fakeApi();
    const r = await runInit({ cwd: project, operations: ['deals.listDeals'], dryRun: true, yes: true, interactive: false, source: 'init', fetchImpl });
    expect(r.operations).toEqual(['deals.listDeals']);
    await expect(runInit({ cwd: project, operations: ['deals.nope'], dryRun: true, yes: true, interactive: false, source: 'init', fetchImpl })).rejects.toThrow(/deals.nope/);
  });

  it('--web-agent picks a stored token when several are stored and there is no registry yet', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'fn-proj2-'));
    await mkdir(join(fresh, 'src', 'app'), { recursive: true });
    await saveAdapterCredential({ webAgent: 'wa_other', token: 'adp_other', apiBase: 'https://api.test/sdk', createdAt: 'now' });
    try {
      const { fetchImpl } = fakeApi();
      await expect(runInit({ cwd: fresh, dryRun: true, yes: true, interactive: false, source: 'init', fetchImpl })).rejects.toThrow(/--web-agent/);
      await expect(runInit({ cwd: fresh, webAgent: 'wa_nope', dryRun: true, yes: true, interactive: false, source: 'init', fetchImpl })).rejects.toThrow(/wa_nope/);
      const r = await runInit({ cwd: fresh, webAgent: 'wa_e2e', dryRun: true, yes: true, interactive: false, source: 'init', fetchImpl });
      expect(r.webAgent).toBe('wa_e2e');
      expect(r.files.every((f) => f.action === 'create')).toBe(true);
    } finally {
      await rm(fresh, { recursive: true, force: true });
      await rm(join(home, 'adapters', 'wa_other.json'), { force: true });
    }
  });
});
