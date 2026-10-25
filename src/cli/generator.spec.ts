import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  bindableOperations,
  importPathFor,
  layoutFor,
  planHash,
  readLayout,
  renderAgentsBlock,
  renderRegistry,
  renderRouteHandler,
  upsertAgentsBlock,
  webAgentOfRegistry,
} from './generator';
import { createRegistry } from '../registry';
import type { SurfaceOperation } from './internal/client';

const ops: SurfaceOperation[] = [
  { operation: 'deals.createDeal', kind: 'server-action', file: 'src/app/deals/actions.ts', symbol: 'createDeal', description: 'Creates a deal' },
  { operation: 'deals.listDeals', kind: 'data-layer', file: 'src/lib/data/deals.ts', symbol: 'listDeals', description: 'Lists the deals' },
  { operation: 'deals.list', kind: 'route-handler', file: 'src/app/api/deals/route.ts', symbol: 'GET', description: 'Already a URL' },
  { operation: 'tenant.page', kind: 'inline-rsc-read', file: 'src/app/tenant/[slug]/page.tsx', symbol: 'prisma.tenant.findUnique', description: 'inline', suggestion: 'extract getTenant' },
  { operation: 'Bad-Name', kind: 'server-action', file: 'src/app/x.ts', symbol: 'x', description: 'invalid name' },
];

describe('generator', () => {
  const dirs: string[] = [];
  afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

  it('binds only adapter kinds with valid names, honouring --operations', () => {
    expect(bindableOperations(ops).map((o) => o.operation)).toEqual(['deals.createDeal', 'deals.listDeals']);
    expect(bindableOperations(ops, ['deals.listDeals']).map((o) => o.operation)).toEqual(['deals.listDeals']);
  });

  it('imports through the alias when tsconfig has one, relatively otherwise', () => {
    const aliased = layoutFor('src', '@/');
    expect(importPathFor('src/app/deals/actions.ts', aliased.registryFile, aliased)).toBe('@/app/deals/actions');
    const plain = layoutFor('', null);
    expect(importPathFor('app/deals/actions.ts', plain.registryFile, plain)).toBe('../app/deals/actions');
    expect(importPathFor(plain.registryFile, plain.routeFile, plain)).toBe('../../../../faustine/registry');
  });

  it('renders a registry the runtime accepts, with the same hash the generator reports', async () => {
    const layout = layoutFor('src', '@/');
    const plan = { webAgent: 'wa_1', operations: bindableOperations(ops).map((o) => ({ operation: o.operation, file: o.file, symbol: o.symbol, description: o.description })) };
    const source = renderRegistry(plan, layout);
    expect(source).toContain("'deals.createDeal': { fn: () => import('@/app/deals/actions').then((m) => m.createDeal) },");
    expect(source).toContain("'deals.listDeals': { fn: () => import('@/lib/data/deals').then((m) => m.listDeals) },");
    const withParams = renderRegistry({ webAgent: 'wa_1', operations: [{ ...plan.operations[0], params: ['id', { name: '_prev', kind: 'prevState' }, { name: 'formData', kind: 'formData' }] }] }, layout);
    expect(withParams).toContain("m.createDeal), params: ['id', { name: '_prev', kind: 'prevState' }, { name: 'formData', kind: 'formData' }] },");
    expect(webAgentOfRegistry(source)).toBe('wa_1');
    // Evaluate the generated map the way the runtime would, to compare hashes.
    const registry = createRegistry({ webAgent: 'wa_1', formatVersion: 1 }, {
      'deals.createDeal': { fn: () => () => null },
      'deals.listDeals': { fn: () => () => null },
    });
    expect(planHash(plan)).toBe(registry.hash);
    expect(renderRouteHandler(layout)).toBe(`import { createFaustineHandler } from '@faustine-ai/next'\nimport registry from '@/faustine/registry'\n\nexport const { GET, POST } = createFaustineHandler(registry)\n`);
  });

  it('upserts the AGENTS.md block without touching the rest', () => {
    const block = renderAgentsBlock(layoutFor('', null));
    const fresh = upsertAgentsBlock(null, block);
    expect(fresh.startsWith('# Agent instructions')).toBe(true);
    const appended = upsertAgentsBlock('# My app\n\nRules.\n', block);
    expect(appended).toContain('Rules.\n\n<!-- BEGIN:faustine -->');
    const replaced = upsertAgentsBlock(appended.replace('npx faustine-next sync', 'OLD'), block);
    expect(replaced).not.toContain('OLD');
    expect(replaced.split('<!-- BEGIN:faustine -->')).toHaveLength(2);
  });

  it('readLayout: src/app with the @/ alias (tsconfig with comments and trailing commas), app/ without tsconfig, no app tree at all', async () => {
    const withSrc = await mkdtemp(join(tmpdir(), 'fn-'));
    dirs.push(withSrc);
    await mkdir(join(withSrc, 'src', 'app'), { recursive: true });
    await writeFile(join(withSrc, 'tsconfig.json'), '{\n  // created by create-next-app\n  "compilerOptions": { "paths": { "@/*": ["./src/*"], }, },\n}');
    expect(await readLayout(withSrc)).toMatchObject({ srcRoot: 'src', alias: '@/', registryFile: 'src/faustine/registry.ts', routeFile: 'src/app/api/faustine/[...op]/route.ts' });

    const root = await mkdtemp(join(tmpdir(), 'fn-'));
    dirs.push(root);
    await mkdir(join(root, 'app'), { recursive: true });
    expect(await readLayout(root)).toMatchObject({ srcRoot: '', alias: null, registryFile: 'faustine/registry.ts' });

    const none = await mkdtemp(join(tmpdir(), 'fn-'));
    dirs.push(none);
    await expect(readLayout(none)).rejects.toThrow(/No `app\/`/);
  });
});
