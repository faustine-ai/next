import type { OperationParam } from '../registry';

/**
 * The parameter list of an exported function, read from its source — what
 * the generator writes as `params` on the registry line so the handler can
 * turn the agent's JSON input into the call. Pure text parsing (no TypeScript
 * compiler): good enough for `export async function f(a: T, b = 1)`,
 * `export const f = async (a: T) => …`, `export const f = cache(async (a) => …)`
 * and a single destructured object. Anything else → `null` (the handler then
 * passes the input as the one argument, as before).
 */
export function parseFunctionParams(source: string, symbol: string): OperationParam[] | null {
  const list = parameterList(source, symbol);
  if (list === null) return null;
  const raw = splitTopLevel(list).map((s) => s.trim()).filter(Boolean);
  const params = raw.map((p, i) => describe(p, i));
  // A `useActionState` action takes the previous state right before its FormData.
  for (let i = 1; i < params.length; i++) {
    if (params[i].kind === 'formData' && params[i - 1].kind === 'value' && /prev|state|initial/i.test(params[i - 1].nameOrType)) {
      params[i - 1].kind = 'prevState';
    }
  }
  return params.map((p) => (p.kind === 'value' ? p.name : { name: p.name, kind: p.kind }));
}

interface Described {
  name: string;
  kind: 'value' | 'formData' | 'prevState';
  nameOrType: string;
}

function describe(param: string, index: number): Described {
  let p = param;
  if (p.startsWith('...')) p = p.slice(3);
  const type = topLevelSplitOnce(p, ':');
  const head = stripDefault(type.before).replace(/\?$/, '').trim();
  const annotation = type.after ? stripDefault(type.after).trim() : '';
  const name = /^[A-Za-z_$][\w$]*$/.test(head) ? head : head.startsWith('{') ? 'input' : head.startsWith('[') ? 'items' : `arg${index}`;
  const kind: Described['kind'] = /\bFormData\b/.test(annotation) ? 'formData' : 'value';
  return { name, kind, nameOrType: `${name} ${annotation}` };
}

function stripDefault(s: string): string {
  return topLevelSplitOnce(s, '=').before;
}

/** Finds the text between the parentheses of the exported function `symbol`, or null. */
export function parameterList(source: string, symbol: string): string | null {
  const fn = new RegExp(`export\\s+(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${escape(symbol)}\\s*(?:<[^()]*>)?\\s*\\(`);
  let m = fn.exec(source);
  if (m) return balanced(source, m.index + m[0].length - 1);
  const decl = new RegExp(`export\\s+(?:const|let|var)\\s+${escape(symbol)}\\b[^=]*=`);
  m = decl.exec(source);
  if (!m) return null;
  // After `=`: optional wrappers (`cache(`, `withAuth(`), then `async (` / `(` / `async x =>` / `function (`.
  let i = m.index + m[0].length;
  for (let hops = 0; hops < 4; hops++) {
    const rest = source.slice(i);
    const single = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(rest);
    if (single) return single[1];
    const arrow = /^\s*(?:async\s*)?(?:function\s*\*?\s*[A-Za-z_$]*\s*)?(?:<[^()]*>)?\s*\(/.exec(rest);
    if (arrow) {
      const open = i + arrow[0].length - 1;
      const inner = balanced(source, open);
      if (inner === null) return null;
      const after = source.slice(open + inner.length + 2).trimStart();
      if (after.startsWith('=>') || after.startsWith('{') || after.startsWith(':')) return inner;
      // A wrapper call like `cache(async (a) => …)`: step inside.
      i = open + 1;
      continue;
    }
    const wrapper = /^\s*[A-Za-z_$][\w$.]*\s*(?:<[^()]*>)?\s*\(/.exec(rest);
    if (wrapper) {
      i += wrapper[0].length;
      continue;
    }
    return null;
  }
  return null;
}

/** The text inside the parenthesis opening at `open`, or null when unbalanced. */
function balanced(source: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if ('({[<'.includes(c)) depth++;
    else if (')}]>'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

function topLevelSplitOnce(s: string, sep: string): { before: string; after: string | null } {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if ('({[<'.includes(c)) depth++;
    else if (')}]>'.includes(c)) depth--;
    else if (c === sep && depth === 0 && !(sep === '=' && (s[i + 1] === '>' || s[i + 1] === '='))) {
      return { before: s.slice(0, i), after: s.slice(i + 1) };
    }
  }
  return { before: s, after: null };
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
