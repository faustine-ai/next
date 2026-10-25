import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AdapterClient, DEFAULT_API_BASE, type SurfaceOperation } from './internal/client';
import { findCredentialBySetupCode, hashSetupCode, listAdapterCredentials, loadAdapterCredential, saveAdapterCredential, type AdapterCredential } from './internal/config';
import { usageError } from './internal/errors';
import {
  bindableOperations,
  planHash,
  readLayout,
  renderAgentsBlock,
  renderRegistry,
  operationsOfRegistry,
  renderRouteHandler,
  upsertAgentsBlock,
  webAgentOfRegistry,
  type AppLayout,
  type RegistryPlan,
} from './generator';
import { REGISTRY_FORMAT_VERSION } from '../registry';
import { parseFunctionParams } from './params';

export interface InitOptions {
  cwd: string;
  setup?: string | null;
  /** Which stored adapter token to use when there is no registry yet and several are stored. */
  webAgent?: string | null;
  api?: string | null;
  operations?: string[] | null;
  dryRun: boolean;
  yes: boolean;
  interactive: boolean;
  /** `sync` (I3) is `init` run again: same plan, the report says so. */
  source: 'init' | 'sync';
  fetchImpl?: typeof fetch;
}

export interface FileChange {
  path: string;
  action: 'create' | 'update' | 'unchanged';
}

export interface InitResult {
  webAgent: string;
  registryHash: string;
  operations: string[];
  skipped: { operation: string; reason: string }[];
  files: FileChange[];
  dryRun: boolean;
  reported: boolean;
  credentialFile: string | null;
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * The credential to use, in order: the one a setup code was exchanged for
 * earlier (a dry-run exchanges the code and stores the token, so the real run
 * may repeat the same code); a setup code exchanged now; `--web-agent`; the
 * registry's Web Agent; the only stored one.
 */
async function resolveCredential(opts: InitOptions, layout: AppLayout): Promise<{ cred: AdapterCredential; file: string | null }> {
  const apiBase = (opts.api ?? process.env.FAUSTINE_API ?? DEFAULT_API_BASE).replace(/\/$/, '');
  if (opts.setup) {
    const code = opts.setup.trim();
    const earlier = await findCredentialBySetupCode(code);
    if (earlier) return { cred: earlier, file: null };
    const client = new AdapterClient(apiBase, null, opts.fetchImpl);
    const res = await client.setup(code);
    const cred: AdapterCredential = { webAgent: res.webAgent, token: res.token, apiBase, createdAt: new Date().toISOString(), setupCodeHash: hashSetupCode(code) };
    const file = await saveAdapterCredential(cred);
    return { cred, file };
  }
  if (opts.webAgent) {
    const cred = await loadAdapterCredential(opts.webAgent.trim());
    if (cred) return { cred, file: null };
    throw usageError(`No adapter token for Web Agent ${opts.webAgent} on this machine — run \`faustine-next init --setup <code>\` with a code from its portal page.`);
  }
  const existing = await readIfExists(join(opts.cwd, layout.registryFile));
  const fromRegistry = existing ? webAgentOfRegistry(existing) : null;
  if (fromRegistry) {
    const cred = await loadAdapterCredential(fromRegistry);
    if (cred) return { cred, file: null };
    throw usageError(`The registry binds Web Agent ${fromRegistry} but this machine has no adapter token for it — run \`faustine-next init --setup <code>\` with a new code from the portal.`);
  }
  const all = await listAdapterCredentials();
  if (all.length === 1) return { cred: all[0], file: null };
  if (all.length === 0) throw usageError('No setup code and no stored adapter token — copy the code from the portal (Add the Faustine adapter) and run `faustine-next init --setup <code>`.');
  throw usageError(`Several adapter tokens are stored (${all.map((c) => c.webAgent).join(', ')}) and there is no registry yet — pass --web-agent <id> to pick one, or repeat the --setup <code> you used (it reuses the token).`);
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const layout = await readLayout(opts.cwd);
  const { cred, file: credentialFile } = await resolveCredential(opts, layout);
  const client = new AdapterClient(cred.apiBase, cred.token, opts.fetchImpl);
  const surface = await client.surface();
  if (surface.formatVersion !== REGISTRY_FORMAT_VERSION) {
    throw usageError(`Faustine's surface map is format ${surface.formatVersion}; this generator writes format ${REGISTRY_FORMAT_VERSION}. Update @faustine-ai/next.`);
  }

  // `sync` keeps the developer's choice: without --operations, the existing
  // registry's lines are the selection, plus the operations that are NEW
  // since the last report — not in the registry and not among what the
  // generator SAW last time (bound or left out). A line the developer removed,
  // or never took, was seen then, so it stays out.
  const existingRegistry = await readIfExists(join(opts.cwd, layout.registryFile));
  const existingOps = existingRegistry ? operationsOfRegistry(existingRegistry) : [];
  let selection: string[] | null = opts.operations ?? null;
  if (!selection && opts.source === 'sync' && existingOps.length > 0) {
    const last = (await client.status().catch(() => null))?.registry ?? null;
    const lastSeen = last?.seen ?? last?.operations ?? [];
    const fresh = surface.operations.map((o) => o.operation).filter((op) => !existingOps.includes(op) && !lastSeen.includes(op));
    selection = [...existingOps, ...fresh];
  }
  const selected = bindableOperations(surface.operations, selection);
  const selectedNames = new Set(selected.map((o) => o.operation));
  const skipped = surface.operations
    .filter((o) => !selectedNames.has(o.operation))
    .map((o) => ({ operation: o.operation, reason: skipReason(o, selection) }));
  if (opts.operations) {
    for (const name of opts.operations) {
      if (!surface.operations.some((o) => o.operation === name)) {
        throw usageError(`--operations names "${name}", which is not in the surface map of Web Agent ${surface.webAgent}.`);
      }
    }
  }
  if (selected.length === 0) {
    throw usageError('Nothing to bind: the surface map has no Server Action or data-layer function for this Web Agent. Run the analysis first, or check the Data surface card in the portal.');
  }

  const plan: RegistryPlan = { webAgent: surface.webAgent, operations: [] };
  for (const o of selected) {
    // The parameter list, read from the function's source: how the handler maps the input to the call.
    const src = await readIfExists(join(opts.cwd, o.file));
    const params = src ? parseFunctionParams(src, o.symbol) : null;
    plan.operations.push({ operation: o.operation, file: o.file, symbol: o.symbol, description: o.description, params });
  }
  const outputs: { path: string; content: string }[] = [
    { path: layout.registryFile, content: renderRegistry(plan, layout) },
    { path: layout.routeFile, content: renderRouteHandler(layout) },
  ];
  const agentsExisting = await readIfExists(join(opts.cwd, layout.agentsFile));
  outputs.push({ path: layout.agentsFile, content: upsertAgentsBlock(agentsExisting, renderAgentsBlock(layout)) });

  const files: FileChange[] = [];
  for (const out of outputs) {
    const current = await readIfExists(join(opts.cwd, out.path));
    files.push({ path: out.path, action: current === null ? 'create' : current === out.content ? 'unchanged' : 'update' });
  }

  const hash = planHash(plan);
  const result: InitResult = {
    webAgent: surface.webAgent,
    registryHash: hash,
    operations: plan.operations.map((o) => o.operation),
    skipped,
    files,
    dryRun: opts.dryRun,
    reported: false,
    credentialFile,
  };
  if (opts.dryRun) return result;
  if (!opts.interactive && !opts.yes) {
    throw usageError('Not a terminal: pass --yes to write the files (or --dry-run to only print the plan).');
  }
  for (const out of outputs) {
    const abs = join(opts.cwd, out.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, out.content);
  }
  await client.reportRegistry({
    registryHash: hash,
    formatVersion: REGISTRY_FORMAT_VERSION,
    operations: result.operations,
    seen: bindableOperations(surface.operations).map((o) => o.operation),
    source: opts.source,
  });
  result.reported = true;
  return result;
}

function skipReason(o: SurfaceOperation, only?: string[] | null): string {
  if (only && only.length > 0 && !only.includes(o.operation)) return 'left out (not in --operations or removed from the registry)';
  if (o.kind === 'route-handler' || o.kind === 'client-fetch') return 'already reachable (has a URL)';
  if (o.kind === 'inline-rsc-read') return `not reachable — ${o.suggestion ?? 'extract it into a data function'}`;
  if (!/^[A-Za-z_$][\w$]*$/.test(o.symbol)) return `symbol "${o.symbol}" is not an exported identifier`;
  return 'invalid operation name';
}

/** `sync --check` (CI gate): exit 1 when the registry or the handler would change, 0 when in step. */
export function syncCheckDrifted(r: InitResult): boolean {
  return r.files.some((f) => f.action !== 'unchanged');
}

export function describeInit(r: InitResult): string {
  const lines = [
    `${r.dryRun ? 'Plan for' : 'Faustine adapter for'} Web Agent ${r.webAgent} — registry ${r.registryHash}`,
    '',
    ...r.files.map((f) => `  ${f.action.padEnd(9)} ${f.path}`),
    '',
    `  ${r.operations.length} operation(s) bound:`,
    ...r.operations.map((o) => `    - ${o}`),
  ];
  if (r.skipped.length > 0) {
    lines.push('', `  ${r.skipped.length} left out:`, ...r.skipped.map((s) => `    - ${s.operation}: ${s.reason}`));
  }
  lines.push(
    '',
    r.dryRun
      ? r.files.every((f) => f.action === 'unchanged')
        ? 'In step: nothing would change.'
        : 'Nothing written (--dry-run).'
      : `Written. Review the registry, mount <FaustineAgent/> in the root layout if it is not there yet, then \`npm run build\` and \`npx faustine-next doctor\`.${r.reported ? ' Faustine knows the registry hash.' : ''}`,
  );
  if (r.credentialFile) {
    lines.push(`Adapter token stored at ${r.credentialFile}.${r.dryRun ? ' The setup code is spent: run init again with the same --setup <code> (it reuses the token) or without it.' : ''}`);
  }
  return lines.join('\n');
}
