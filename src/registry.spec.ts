import { describe, expect, it } from 'vitest';
import { createRegistry, registryHash, REGISTRY_FORMAT_VERSION } from './registry';

describe('createRegistry', () => {
  it('validates names, sorts operations and hashes the contract', () => {
    const r = createRegistry(
      { webAgent: 'wa_1' },
      {
        'deals.create': { fn: async () => (input: unknown) => input },
        'deals.list': { fn: () => () => [] , schema: () => (i: unknown) => i },
      },
    );
    expect(r.formatVersion).toBe(REGISTRY_FORMAT_VERSION);
    expect(r.operations).toEqual(['deals.create', 'deals.list']);
    expect(r.hash).toHaveLength(16);
    // The hash depends on names, schema presence and confirm — not on the functions.
    const same = registryHash({ webAgent: 'wa_1', formatVersion: 1 }, [
      { name: 'deals.list', schema: true, confirm: false },
      { name: 'deals.create', schema: false, confirm: false },
    ]);
    expect(r.hash).toBe(same);
    expect(registryHash({ webAgent: 'wa_2', formatVersion: 1 }, [])).not.toBe(r.hash);
  });

  it('rejects bad names, missing fn, missing webAgent and other formats at module load', () => {
    expect(() => createRegistry({ webAgent: 'wa_1' }, { 'Deals.create': { fn: () => () => 1 } })).toThrow(/not a valid operation name/);
    expect(() => createRegistry({ webAgent: 'wa_1' }, { 'deals-create': { fn: () => () => 1 } })).toThrow(/not a valid operation name/);
    expect(() => createRegistry({ webAgent: 'wa_1' }, { 'deals.create': {} as never })).toThrow(/needs a `fn`/);
    expect(() => createRegistry({ webAgent: '' }, {})).toThrow(/webAgent/);
    expect(() => createRegistry({ webAgent: 'wa_1', formatVersion: 2 }, {})).toThrow(/formatVersion 2/);
  });
});
