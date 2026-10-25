import { describe, expect, it, vi } from 'vitest';
import { argumentsFor, createFaustineHandler, originAllowed, structuredNextError, type ServedManifest } from './handler';
import { createRegistry } from './registry';

const registry = createRegistry(
  { webAgent: 'wa_1' },
  {
    'deals.create': { fn: () => async (input: unknown) => ({ id: 'd1', ...(input as object) }) },
    'deals.list': {
      fn: () => () => [{ id: 'd1' }],
      schema: () => ({ safeParse: (i: unknown) => (typeof i === 'object' && i && 'page' in i ? { success: true as const, data: i } : { success: false as const, error: 'page required' }) }),
    },
    'deals.open': {
      fn: () => () => {
        throw Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;push;/deals/d1;307;' });
      },
    },
    'deals.missing': {
      fn: () => () => {
        throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_NOT_FOUND' });
      },
    },
    'deals.boom': {
      fn: () => () => {
        throw new Error('database down');
      },
    },
  },
);

function servedFetch(manifest: ServedManifest | null, status = 200) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url));
    if (!manifest) throw new Error('ECONNREFUSED');
    return new Response(JSON.stringify(manifest), { status, headers: { 'content-type': 'application/json', etag: '"m1"' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const ctx = (op: string) => ({ params: Promise.resolve({ op: op.split('/') }) });
const post = (op: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://app.test/api/faustine/${op}`, {
    method: 'POST',
    headers: { host: 'app.test', 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('createFaustineHandler', () => {
  const served: ServedManifest = { webAgent: 'wa_1', operations: [{ op: 'deals.create' }, { op: 'deals.list' }, { op: 'deals.open' }, { op: 'deals.missing' }, { op: 'deals.boom' }, { op: 'other.notBound' }] };

  it('GET /manifest answers the registry, the build and the intersection with the served manifest', async () => {
    const { fetchImpl, calls } = servedFetch(served);
    const { GET } = createFaustineHandler(registry, { fetch: fetchImpl, apiBase: 'https://wa.test', buildSha: 'abc123' });
    const res = await GET(new Request('http://app.test/api/faustine/manifest'), ctx('manifest'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-faustine-registry')).toBe(registry.hash);
    expect(res.headers.get('x-faustine-build')).toBe('abc123');
    const body = await res.json();
    expect(body.webAgent).toBe('wa_1');
    expect(body.registryHash).toBe(registry.hash);
    expect(body.operations.map((o: { op: string }) => o.op)).toEqual(registry.operations);
    expect(body.enabled).toEqual(['deals.boom', 'deals.create', 'deals.list', 'deals.missing', 'deals.open']);
    expect(body.served).toBe('ok');
    expect(calls[0]).toBe(`https://wa.test/adapter-manifest?wid=wa_1&env=Production&registry=${registry.hash}&build=abc123`);
    // A second call within the TTL reuses the cached manifest.
    await GET(new Request('http://app.test/api/faustine/manifest'), ctx('manifest'));
    expect(calls).toHaveLength(1);
  });

  it('POST runs the bound function and returns its result', async () => {
    const { POST } = createFaustineHandler(registry, { fetch: servedFetch(served).fetchImpl });
    const res = await POST(post('deals.create', { title: 'Acme' }), ctx('deals.create'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: { id: 'd1', title: 'Acme' } });
  });

  it('fails closed when the served manifest is unreachable, and refuses operations the manifest does not enable', async () => {
    const down = createFaustineHandler(registry, { fetch: servedFetch(null).fetchImpl });
    const res = await down.POST(post('deals.create', {}), ctx('deals.create'));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('manifest_unavailable');

    const narrow = createFaustineHandler(registry, { fetch: servedFetch({ webAgent: 'wa_1', operations: [{ op: 'deals.list' }] }).fetchImpl });
    const res2 = await narrow.POST(post('deals.create', {}), ctx('deals.create'));
    expect(res2.status).toBe(403);
    expect((await res2.json()).error).toBe('operation_disabled');

    const none = createFaustineHandler(registry, { fetch: servedFetch({ webAgent: 'wa_1', operations: [] }).fetchImpl });
    expect((await none.POST(post('deals.create', {}), ctx('deals.create'))).status).toBe(403);
  });

  it('checks Origin against Host like Server Actions, and rejects unknown operations and bad JSON', async () => {
    const { POST } = createFaustineHandler(registry, { fetch: servedFetch(served).fetchImpl });
    expect((await POST(post('deals.create', {}, { origin: 'https://evil.test' }), ctx('deals.create'))).status).toBe(403);
    expect((await POST(post('deals.create', {}, { origin: 'http://app.test' }), ctx('deals.create'))).status).toBe(200);
    expect((await POST(post('deals.nope', {}), ctx('deals.nope'))).status).toBe(404);
    const bad = new Request('http://app.test/api/faustine/deals.create', { method: 'POST', headers: { host: 'app.test' }, body: '{not json' });
    expect((await POST(bad, ctx('deals.create'))).status).toBe(400);
  });

  it('validates input with the schema when there is one', async () => {
    const { POST } = createFaustineHandler(registry, { fetch: servedFetch(served).fetchImpl });
    const bad = await POST(post('deals.list', {}), ctx('deals.list'));
    expect(bad.status).toBe(422);
    expect((await bad.json()).issues).toBe('page required');
    const ok = await POST(post('deals.list', { page: 1 }), ctx('deals.list'));
    expect(await ok.json()).toEqual({ ok: true, result: [{ id: 'd1' }] });
  });

  it('returns redirect() and notFound() as structured results, other throws as 500', async () => {
    const { POST } = createFaustineHandler(registry, { fetch: servedFetch(served).fetchImpl });
    expect(await (await POST(post('deals.open', {}), ctx('deals.open'))).json()).toEqual({ ok: true, result: null, kind: 'redirect', url: '/deals/d1', permanent: false });
    expect(await (await POST(post('deals.missing', {}), ctx('deals.missing'))).json()).toEqual({ ok: true, result: null, kind: 'notFound' });
    const boom = await POST(post('deals.boom', {}), ctx('deals.boom'));
    expect(boom.status).toBe(500);
    expect((await boom.json()).message).toBe('database down');
  });
});

describe('argumentsFor: the registry line params map the input to the call', () => {
  it('no params or one value parameter: the input is the argument', () => {
    expect(argumentsFor(undefined, { id: 'b1' })).toEqual([{ id: 'b1' }]);
    expect(argumentsFor(['id'], 'b1')).toEqual(['b1']);
    expect(argumentsFor(['query'], { q: 'x' })).toEqual([{ q: 'x' }]);
    expect(argumentsFor(['id'], { id: 'b1' })).toEqual(['b1']);
    expect(argumentsFor(['query'], { query: { q: 'x' } })).toEqual([{ q: 'x' }]);
    expect(argumentsFor(['query'], { query: 'x', extra: 1 })).toEqual([{ query: 'x', extra: 1 }]);
    expect(argumentsFor([], {})).toEqual([]);
  });
  it('several parameters: an object keyed by name; FormData built from fields; prevState never sent', () => {
    expect(argumentsFor(['id', 'days'], { id: 'l1', days: 7 })).toEqual(['l1', 7]);
    const [prev, fd] = argumentsFor([{ name: '_prev', kind: 'prevState' }, { name: 'formData', kind: 'formData' }], { title: 'T', tags: ['a', 'b'], meta: { x: 1 } });
    expect(prev).toBeUndefined();
    expect(fd).toBeInstanceOf(FormData);
    expect((fd as FormData).get('title')).toBe('T');
    expect((fd as FormData).getAll('tags')).toEqual(['a', 'b']);
    expect((fd as FormData).get('meta')).toBe('{"x":1}');
    const [id, p2, fd2] = argumentsFor(['id', { name: '_prev', kind: 'prevState' }, { name: 'formData', kind: 'formData' }], { id: 'b1', title: 'T' });
    expect([id, p2]).toEqual(['b1', undefined]);
    expect((fd2 as FormData).get('title')).toBe('T');
    expect((fd2 as FormData).get('id')).toBe('b1');
  });
  it('POST runs a positional function through params', async () => {
    const reg = createRegistry({ webAgent: 'wa_1', formatVersion: 1 }, {
      'loans.extend': { fn: () => (id: string, days: number) => ({ id, days }), params: ['id', 'days'] },
    });
    const { POST } = createFaustineHandler(reg, { fetch: servedFetch({ webAgent: 'wa_1', operations: [{ op: 'loans.extend' }] }).fetchImpl });
    const res = await POST(post('loans.extend', { id: 'l1', days: 3 }), ctx('loans.extend'));
    expect(await res.json()).toEqual({ ok: true, result: { id: 'l1', days: 3 } });
  });
});

describe('helpers', () => {
  it('originAllowed', () => {
    const req = (h: Record<string, string>) => new Request('http://x/', { headers: h });
    expect(originAllowed(req({ host: 'app.test' }))).toBe(true);
    expect(originAllowed(req({ host: 'app.test', origin: 'https://app.test' }))).toBe(true);
    expect(originAllowed(req({ host: 'app.test', 'x-forwarded-host': 'public.test', origin: 'https://public.test' }))).toBe(true);
    expect(originAllowed(req({ host: 'app.test', origin: 'https://other.test' }))).toBe(false);
  });
  it('structuredNextError', () => {
    expect(structuredNextError({ digest: 'NEXT_REDIRECT;replace;/x;308;' })).toEqual({ kind: 'redirect', url: '/x', permanent: true });
    expect(structuredNextError({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' })).toEqual({ kind: 'notFound' });
    expect(structuredNextError(new Error('x'))).toBeNull();
  });
});
