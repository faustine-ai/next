/**
 * Output contract shared with the gateway CLI: JSON when stdout is not a TTY
 * or `--json`; plain text on a TTY. Errors always go to stderr.
 */
export interface OutputMode {
  json: boolean;
  quiet: boolean;
}

export function resolveMode(opts: { json?: boolean; quiet?: boolean }, stdout: { isTTY?: boolean } = process.stdout): OutputMode {
  return { json: opts.json === true ? true : !stdout.isTTY, quiet: Boolean(opts.quiet) };
}

export function emit(mode: OutputMode, data: unknown, text: () => string): void {
  if (mode.quiet) return;
  process.stdout.write((mode.json ? JSON.stringify(data, null, 2) : text()) + '\n');
}

export function emitError(mode: OutputMode, err: { toJSON(): unknown; message: string; code?: string }): void {
  process.stderr.write((mode.json ? JSON.stringify(err.toJSON()) : `error (${err.code ?? 'error'}): ${err.message}`) + '\n');
}
