import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AdapterClient, type AdapterStatus } from './internal/client';
import { loadAdapterCredential } from './internal/config';
import { networkError, usageError } from './internal/errors';
import { readLayout, webAgentOfRegistry } from './generator';
import { parseRegistrySource } from './registry-source';
import type { ManifestResponse } from '../handler';

/**
 * `faustine-next doctor [--url http://localhost:3000]`: asks the running app
 * what it serves (`/api/faustine/manifest`) and Faustine what it expects, and
 * prints the differences. The skill's verification step; the first thing to
 * run on a drift warning.
 */
export interface DoctorOptions {
  cwd: string;
  url: string;
  fetchImpl?: typeof fetch;
}

export interface DoctorResult {
  url: string;
  webAgent: string | null;
  /** The registry in this checkout, parsed statically. */
  local: { hash: string; operations: string[] } | null;
  app: ManifestResponse | null;
  faustine: AdapterStatus | null;
  findings: { level: 'ok' | 'warn' | 'error'; message: string }[];
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const findings: DoctorResult['findings'] = [];
  const base = opts.url.replace(/\/$/, '');

  let app: ManifestResponse | null = null;
  try {
    const res = await fetchImpl(`${base}/api/faustine/manifest`);
    if (res.ok) app = (await res.json()) as ManifestResponse;
    else findings.push({ level: 'error', message: `${base}/api/faustine/manifest answered ${res.status} — is the route handler mounted and the app running?` });
  } catch (e) {
    throw networkError(`Could not reach ${base}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // The registry in this checkout, read statically: the third point of comparison.
  let local: { hash: string; operations: string[] } | null = null;
  try {
    const layout = await readLayout(opts.cwd);
    const parsed = parseRegistrySource(await readFile(join(opts.cwd, layout.registryFile), 'utf-8'));
    local = { hash: parsed.hash, operations: parsed.entries.map((e) => e.operation) };
  } catch {
    // no registry here
  }
  let webAgent = app?.webAgent ?? null;
  if (!webAgent) {
    try {
      const layout = await readLayout(opts.cwd);
      webAgent = webAgentOfRegistry(await readFile(join(opts.cwd, layout.registryFile), 'utf-8'));
    } catch {
      // no registry here either
    }
  }
  if (!webAgent) throw usageError('No Web Agent id: the app did not answer a manifest and there is no registry in this directory.');

  let faustine: AdapterStatus | null = null;
  const cred = await loadAdapterCredential(webAgent);
  if (cred) {
    faustine = await new AdapterClient(cred.apiBase, cred.token, fetchImpl).status();
  } else {
    findings.push({ level: 'warn', message: `No adapter token for ${webAgent} on this machine — comparing the app with itself only. Run \`faustine-next init --setup <code>\` to compare with Faustine.` });
  }

  if (app) {
    if (app.served === 'unreachable') findings.push({ level: 'error', message: 'The app cannot reach Faustine for the served manifest: it exposes nothing. Check outbound network from the server to webagent.faustine.ai.' });
    else if (app.served === 'none') findings.push({ level: 'warn', message: 'Faustine serves no enabled operation for this Web Agent yet — publish a version that includes the adapter methods.' });
    else findings.push({ level: 'ok', message: `The app serves ${app.enabled?.length ?? 0} of ${app.operations.length} bound operation(s).` });
    if (!app.buildSha) findings.push({ level: 'warn', message: 'The app reports no build SHA — wrap next.config with withFaustine() or set FAUSTINE_BUILD_SHA so the portal can tell which commit runs.' });
  }
  if (app && faustine) {
    if (faustine.registry && faustine.registry.hash !== app.registryHash) {
      findings.push({ level: 'warn', message: `Registry drift: the app runs registry ${app.registryHash}, Faustine last saw ${faustine.registry.hash} (reported ${faustine.registry.reportedAt}). Deploy the registry you generated, or run init again.` });
    } else if (faustine.registry) {
      findings.push({ level: 'ok', message: `Registry ${app.registryHash} matches what Faustine knows.` });
    }
    const bound = new Set<string>(app.operations.map((o) => o.op));
    const notBound = faustine.enabled.filter((op) => !bound.has(op));
    if (notBound.length > 0) findings.push({ level: 'warn', message: `Enabled in Faustine but not bound in this build: ${notBound.join(', ')}.` });
    const notEnabled = app.operations.map((o) => o.op).filter((op) => !faustine!.enabled.includes(op));
    if (notEnabled.length > 0) findings.push({ level: 'ok', message: `Bound but not enabled (the portal decides): ${notEnabled.join(', ')}.` });
  }
  if (app && local && local.hash !== app.registryHash) {
    findings.push({ level: 'warn', message: `This checkout's registry is ${local.hash}; the app at ${base} runs ${app.registryHash} — a deploy is pending, or the app is another build.` });
  }
  if (faustine) findings.push(...describeFaustineState(faustine, local));
  return { url: base, webAgent, local, app, faustine, findings };
}

/** I3: what Faustine's push check and the live build say, in the setup path's words. */
export function describeFaustineState(f: AdapterStatus, local: { hash: string; operations: string[] } | null): DoctorResult['findings'] {
  const out: DoctorResult['findings'] = [];
  if (f.state && f.binds) {
    const where =
      f.state === 'deployed'
        ? `Faustine: deployed${f.deployed?.buildSha ? ` (build ${f.deployed.buildSha.slice(0, 7)})` : ''}`
        : f.state === 'in_repo'
          ? `Faustine: adapter in the repo at ${f.repo?.sha.slice(0, 7) ?? '?'}`
          : f.state === 'generated'
            ? 'Faustine: adapter generated, waiting for a push'
            : 'Faustine: no adapter known yet';
    out.push({ level: 'ok', message: `${where} — the registry binds ${f.binds.bound} of ${f.binds.total} operation(s) the analysis named.` });
  }
  if (f.repo && local && f.repo.found && f.repo.hash && f.repo.hash !== local.hash) {
    out.push({ level: 'warn', message: `The last commit Faustine checked carries registry ${f.repo.hash}; this checkout has ${local.hash} — push it, or pull.` });
  }
  for (const g of f.gaps ?? []) {
    if (g.kind === 'registry_incomplete') {
      out.push({ level: 'warn', message: g.noRegistry ? 'The last commit has no registry — the adapter was removed from the repo, or the push did not include it.' : `Missing from the registry: ${g.missing.join(', ')}. Run \`npx faustine-next sync\`, review the diff, deploy — or switch those operations off in the portal.` });
    } else if (g.kind === 'repo_ahead_of_deploy') {
      out.push({ level: 'ok', message: `The repo's registry (${g.repoHash}) is ahead of the live build (${g.deployedHash}) — waiting for a deploy.` });
    } else {
      out.push({ level: 'error', message: `Broken binding(s) in the last commit: ${g.broken.map((b) => `${b.operation} (${b.reason})`).join('; ')}. The app's build should fail on these; fix the registry.` });
    }
  }
  return out;
}

export function describeDoctor(r: DoctorResult): string {
  const mark = { ok: '✓', warn: '!', error: '✗' } as const;
  return [
    `faustine-next doctor — ${r.url} — Web Agent ${r.webAgent}`,
    r.app ? `  app: build ${r.app.buildSha ?? '(none)'} · registry ${r.app.registryHash} · ${r.app.operations.length} bound · served ${r.app.served}` : '  app: no manifest',
    r.local ? `  checkout: registry ${r.local.hash} · ${r.local.operations.length} bound` : '  checkout: no registry here',
    '',
    ...r.findings.map((f) => `  ${mark[f.level]} ${f.message}`),
  ].join('\n');
}
