/**
 * The same error model as the gateway CLI (`@faustine-ai/cli`): a machine
 * code, a human message, a process exit code. JSON mode prints
 * `{ "error": { "code", "message" } }` on stderr. Lives in `internal/` so it
 * can be lifted into a shared kit when the platform CLI exists.
 */
export const EXIT = {
  OK: 0,
  USAGE: 1,
  AUTH: 2,
  DENIED: 3,
  UPSTREAM: 4,
  NETWORK: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode: ExitCode,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'CliError';
  }
  toJSON(): { error: Record<string, unknown> } {
    return { error: { code: this.code, message: this.message, ...this.extra } };
  }
}

export const usageError = (message: string) => new CliError('usage', message, EXIT.USAGE);
export const authError = (message: string, code = 'unauthorized') => new CliError(code, message, EXIT.AUTH);
export const networkError = (message: string) => new CliError('network', message, EXIT.NETWORK);
export const upstreamError = (message: string, extra?: Record<string, unknown>) =>
  new CliError('upstream_error', message, EXIT.UPSTREAM, extra);
