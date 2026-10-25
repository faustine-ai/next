import { describe, expect, it } from 'vitest';
import { parseRegistrySource } from './registry-source';
import { bindableOperations, layoutFor, planHash, renderRegistry } from './generator';
import type { SurfaceOperation } from './internal/client';
import { createRegistry } from '../registry';

const ops: SurfaceOperation[] = [
  { operation: 'deals.createDeal', kind: 'server-action', file: 'src/app/deals/actions.ts', symbol: 'createDeal', description: 'Creates a deal' },
  { operation: 'deals.listDeals', kind: 'data-layer', file: 'src/lib/data/deals.ts', symbol: 'listDeals', description: 'Lists the deals' },
];

describe('parseRegistrySource', () => {
  it('reads what the generator wrote and lands on the same hash', () => {
    const plan = { webAgent: 'wa_1', operations: bindableOperations(ops).map((o) => ({ operation: o.operation, file: o.file, symbol: o.symbol, description: o.description })) };
    const parsed = parseRegistrySource(renderRegistry(plan, layoutFor('src', '@/')));
    expect(parsed.webAgent).toBe('wa_1');
    expect(parsed.entries.map((e) => [e.operation, e.importSpec, e.symbol])).toEqual([
      ['deals.createDeal', '@/app/deals/actions', 'createDeal'],
      ['deals.listDeals', '@/lib/data/deals', 'listDeals'],
    ]);
    expect(parsed.hash).toBe(planHash(plan));
  });

  it('params are part of the hash, read back as the runtime normalizes them', () => {
    const withParams = {
      webAgent: 'wa_1',
      operations: [{ operation: 'deals.updateDeal', file: 'src/app/deals/actions.ts', symbol: 'updateDeal', description: 'd', params: ['id', { name: '_prev', kind: 'prevState' as const }, { name: 'formData', kind: 'formData' as const }] }],
    };
    const source = renderRegistry(withParams, layoutFor('src', '@/'));
    const parsed = parseRegistrySource(source);
    expect(parsed.entries[0].params).toEqual([{ name: 'id', kind: 'value' }, { name: '_prev', kind: 'prevState' }, { name: 'formData', kind: 'formData' }]);
    expect(parsed.hash).toBe(planHash(withParams));
    expect(parsed.hash).not.toBe(planHash({ ...withParams, operations: [{ ...withParams.operations[0], params: ['id'] }] }));
    const runtime = createRegistry({ webAgent: 'wa_1', formatVersion: 1 }, { 'deals.updateDeal': { fn: () => () => null, params: withParams.operations[0].params } });
    expect(runtime.hash).toBe(parsed.hash);
  });

  it('a hand-edited entry with schema and confirm changes the hash, as the runtime would', () => {
    const edited = `export default createRegistry({ webAgent: "wa_1", formatVersion: 1 }, {
  "deals.createDeal": {
    fn: () => import("@/app/deals/actions").then((mod) => mod.createDeal),
    schema: () => import('@/app/deals/schemas').then((m) => m.createDealInput),
    confirm: true,
  },
})`;
    const parsed = parseRegistrySource(edited);
    expect(parsed.entries[0]).toMatchObject({ schema: true, confirm: true, symbol: 'createDeal' });
    expect(parsed.hash).not.toBe(parseRegistrySource(edited.replace('confirm: true,', '')).hash);
  });
});
