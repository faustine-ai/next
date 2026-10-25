import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Adapter tokens: `~/.config/faustine/adapters/<webAgent>.json` (mode 0600),
 * or under `$FAUSTINE_CONFIG_DIR`. The same directory the gateway CLI uses
 * for its credentials; a different file per Web Agent, because the token is
 * scoped to one.
 */
export interface AdapterCredential {
  webAgent: string;
  token: string;
  apiBase: string;
  createdAt: string;
  /** Hash of the setup code this token came from: a run that repeats the code (dry-run, then init) reuses the token instead of exchanging the code twice. */
  setupCodeHash?: string;
}

export function hashSetupCode(code: string): string {
  return createHash('sha256').update(code.trim()).digest('hex').slice(0, 32);
}

export function configDir(): string {
  const override = process.env.FAUSTINE_CONFIG_DIR;
  if (override && override.trim()) return override;
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.trim() ? xdg : join(homedir(), '.config'), 'faustine');
}

const adaptersDir = () => join(configDir(), 'adapters');
const fileFor = (webAgent: string) => join(adaptersDir(), `${webAgent.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

export async function saveAdapterCredential(cred: AdapterCredential): Promise<string> {
  await mkdir(adaptersDir(), { recursive: true, mode: 0o700 });
  const path = fileFor(cred.webAgent);
  await writeFile(path, JSON.stringify(cred, null, 2) + '\n', { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
  return path;
}

export async function loadAdapterCredential(webAgent: string): Promise<AdapterCredential | null> {
  try {
    return JSON.parse(await readFile(fileFor(webAgent), 'utf-8')) as AdapterCredential;
  } catch {
    return null;
  }
}

/** The credential a setup code was exchanged for earlier on this machine, if any. */
export async function findCredentialBySetupCode(code: string): Promise<AdapterCredential | null> {
  const h = hashSetupCode(code);
  return (await listAdapterCredentials()).find((c) => c.setupCodeHash === h) ?? null;
}

/** All stored credentials — `init` without `--setup` uses the only one when there is exactly one. */
export async function listAdapterCredentials(): Promise<AdapterCredential[]> {
  try {
    const files = await readdir(adaptersDir());
    const out: AdapterCredential[] = [];
    for (const f of files.filter((n) => n.endsWith('.json'))) {
      try {
        out.push(JSON.parse(await readFile(join(adaptersDir(), f), 'utf-8')) as AdapterCredential);
      } catch {
        // skip a corrupt file
      }
    }
    return out;
  } catch {
    return [];
  }
}
