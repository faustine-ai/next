import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { describeDoctor, runDoctor } from './doctor';
import { layoutFor, renderRegistry } from './generator';
import { parseRegistrySource } from './registry-source';
import type { AdapterStatus } from './internal/client';

const plan = { webAgent: 'wa_doc', operations: [{ operation: 'deals.createDeal', file: 'src/app/deals/actions.ts', symbol: 'createDeal', description: 'c' }] };
const source = renderRegistry(plan, layoutFor('src', '@/'));
const localHash = parseRegistrySource(source).hash;

function fakes(status: Partial<AdapterStatus>, appHash = localHash) {
  const manifest = { webAgent: 'wa_doc', formatVersion: 1, registryHash: appHash, buildSha: 'abc1234567', operations: [{ op: 'deals.createDeal', schema: false, confirm: false }], enabled: ['deals.createDeal'], served: 'ok' };
  const full: AdapterStatus = { webAgent: 'wa_doc', registry: { hash: localHash, formatVersion: 1, operations: ['deals.createDeal'], reportedAt: 'r' }, deployed: null, enabled: ['deals.createDeal'], ...status };
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith('/api/faustine/manifest')) return new Response(JSON.stringify(manifest), { status: 200 });
    if (u.endsWith('/adapter/status')) return new Response(JSON.stringify(full), { status: 200 });
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
  return fetchImpl;
}

describe('faustine-next doctor (I3)', () => {
  let project: string;
  let home: string;
  beforeAll(async () => {
    project = await mkdtemp(join(tmpdir(), 'fn-doc-'));
    home = await mkdtemp(join(tmpdir(), 'fn-doc-home-'));
    process.env.FAUSTINE_CONFIG_DIR = home;
    await mkdir(join(project, 'src', 'faustine'), { recursive: true });
    await mkdir(join(project, 'src', 'app'), { recursive: true });
    await writeFile(join(project, 'src', 'faustine', 'registry.ts'), source);
    await mkdir(join(home, 'adapters'), { recursive: true });
    await writeFile(join(home, 'adapters', 'wa_doc.json'), JSON.stringify({ webAgent: 'wa_doc', token: 'fna_t', apiBase: 'https://api.test/sdk', createdAt: 'now' }));
  });
  afterAll(async () => {
    delete process.env.FAUSTINE_CONFIG_DIR;
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('reads the checkout, the app and Faustine, and says where the adapter stands', async () => {
    const r = await runDoctor({
      cwd: project,
      url: 'http://localhost:3000',
      fetchImpl: fakes({ state: 'deployed', binds: { bound: 1, total: 2 }, deployed: { hash: localHash, buildSha: 'abc1234567', at: 'd' }, repo: { sha: 'f00dbabe1234', found: true, hash: localHash, operations: ['deals.createDeal'], broken: [], checkedAt: 'c' }, gaps: [{ kind: 'registry_incomplete', missing: ['deals.archive'], noRegistry: false }] }),
    });
    expect(r.local?.hash).toBe(localHash);
    const messages = r.findings.map((f) => `${f.level} ${f.message}`);
    expect(messages).toContain(`ok Registry ${localHash} matches what Faustine knows.`);
    expect(messages).toContain('ok Faustine: deployed (build abc1234) — the registry binds 1 of 2 operation(s) the analysis named.');
    expect(messages.some((m) => m.startsWith('warn Missing from the registry: deals.archive.'))).toBe(true);
    expect(describeDoctor(r)).toContain(`checkout: registry ${localHash} · 1 bound`);
  });

  it('a checkout ahead of the last checked commit and of the app, broken bindings as errors', async () => {
    const r = await runDoctor({
      cwd: project,
      url: 'http://localhost:3000',
      fetchImpl: fakes({ state: 'in_repo', binds: { bound: 1, total: 1 }, repo: { sha: 'f00dbabe1234', found: true, hash: 'older', operations: ['deals.createDeal'], broken: [{ operation: 'deals.createDeal', reason: 'no export named createDeal in src/app/deals/actions.ts' }], checkedAt: 'c' }, gaps: [{ kind: 'stale_binding', broken: [{ operation: 'deals.createDeal', reason: 'no export named createDeal in src/app/deals/actions.ts' }] }] }, 'other-build'),
    });
    const messages = r.findings.map((f) => `${f.level} ${f.message}`);
    expect(messages.some((m) => m.startsWith(`warn This checkout's registry is ${localHash}; the app at http://localhost:3000 runs other-build`))).toBe(true);
    expect(messages.some((m) => m.startsWith(`warn The last commit Faustine checked carries registry older; this checkout has ${localHash}`))).toBe(true);
    expect(messages.some((m) => m.startsWith('error Broken binding(s) in the last commit: deals.createDeal'))).toBe(true);
  });
});
