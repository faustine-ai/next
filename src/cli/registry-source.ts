import { registryHash, type OperationParamKind } from '../registry';

/**
 * The registry read statically, without evaluating it: what `sync` keeps,
 * what `doctor` compares with the running app, and the same parse Faustine's
 * push check runs on every commit. Tolerant of hand edits (multi-line entries,
 * `schema`, `confirm`, double quotes). The hash is the one the runtime answers.
 */

export interface RegistrySourceEntry {
  operation: string;
  importSpec: string | null;
  symbol: string | null;
  schema: boolean;
  confirm: boolean;
  params: { name: string; kind: OperationParamKind }[] | null;
}

/** `params: ['id', { name: 'formData', kind: 'formData' }]` out of an entry body, normalized; null when the line has none. */
export function parseParamsLiteral(body: string): { name: string; kind: OperationParamKind }[] | null {
  const m = body.match(/\bparams\s*:\s*\[([^\]]*)\]/);
  if (!m) return null;
  const out: { name: string; kind: OperationParamKind }[] = [];
  const item = /(['"])([^'"]*)\1|\{\s*name\s*:\s*(['"])([^'"]*)\3\s*(?:,\s*kind\s*:\s*(['"])([^'"]*)\5)?\s*\}/g;
  let x: RegExpExecArray | null;
  while ((x = item.exec(m[1]))) {
    if (x[2] !== undefined) out.push({ name: x[2], kind: 'value' });
    else out.push({ name: x[4], kind: (x[6] as OperationParamKind | undefined) ?? 'value' });
  }
  return out;
}

export interface RegistrySource {
  webAgent: string | null;
  formatVersion: number;
  entries: RegistrySourceEntry[];
  hash: string;
}

const ENTRY_RE = /(['"])([a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*)\1\s*:\s*\{/g;

export function parseRegistrySource(source: string): RegistrySource {
  const metaBody = source.match(/createRegistry\(\s*\{([^}]*)\}/)?.[1] ?? '';
  const webAgent = metaBody.match(/webAgent\s*:\s*['"]([^'"]+)['"]/)?.[1] ?? null;
  const formatVersion = Number(metaBody.match(/formatVersion\s*:\s*(\d+)/)?.[1] ?? '1');
  const starts: { name: string; at: number; bodyAt: number }[] = [];
  let m: RegExpExecArray | null;
  ENTRY_RE.lastIndex = 0;
  while ((m = ENTRY_RE.exec(source))) starts.push({ name: m[2], at: m.index, bodyAt: m.index + m[0].length });
  const entries: RegistrySourceEntry[] = starts.map((s, i) => {
    const body = source.slice(s.bodyAt, i + 1 < starts.length ? starts[i + 1].at : source.length);
    const imp = body.match(/import\(\s*['"]([^'"]+)['"]\s*\)\s*\.then\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\2\.(\w+)/);
    return { operation: s.name, importSpec: imp?.[1] ?? null, symbol: imp?.[3] ?? null, schema: /\bschema\s*:/.test(body), confirm: /\bconfirm\s*:\s*true\b/.test(body), params: parseParamsLiteral(body) };
  });
  const hash = registryHash(
    { webAgent: webAgent ?? '', formatVersion },
    entries.map((e) => ({ name: e.operation, schema: e.schema, confirm: e.confirm, params: e.params })),
  );
  return { webAgent, formatVersion, entries, hash };
}
