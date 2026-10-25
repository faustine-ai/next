import { runInit, describeInit, syncCheckDrifted } from '../cli/init';
import { runDoctor, describeDoctor } from '../cli/doctor';
import { CliError, EXIT, usageError } from '../cli/internal/errors';
import { emit, emitError, resolveMode } from '../cli/internal/output';

/**
 * faustine-next — the generator shipped with @faustine-ai/next.
 *
 *   faustine-next init [--setup <code>] [--web-agent <id>] [--operations a.b,c.d] [--dry-run] [--yes]
 *   faustine-next sync [--check] [--dry-run] [--operations a.b]
 *   faustine-next doctor [--url http://localhost:3000]
 *
 * Output: JSON when stdout is not a TTY or --json; errors on stderr as
 * {"error":{code,message}}; exit codes 0 ok · 1 usage · 2 auth · 3 denied ·
 * 4 upstream · 5 network.
 */
const HELP = `faustine-next — the Faustine adapter generator for Next.js

Commands
  init     Generate faustine/registry.ts, the route handler and the AGENTS.md block
           from the Web Agent's surface map.
             --setup <code>        setup code from the portal (first run; a dry-run spends it,
                                   repeating the same code afterwards reuses the stored token)
             --web-agent <id>      which stored token to use when several are stored and there is no registry yet
             --operations a.b,c.d  bind only these operations
             --dry-run             print the plan, write nothing
             --yes                 write without a terminal (CI, agents)
  sync     Bring the registry in step after new Server Actions or data functions:
           keeps your selection (a removed line stays removed), adds what is new,
           reports the hash to Faustine. Same flags as init.
             --check               CI gate: exit 1 when the registry would change, write nothing
             --dry-run             print what would change
  doctor   Compare the running app with what Faustine expects.
             --url <origin>        default http://localhost:3000

Global: --json  --quiet  --help  --version`;

function parse(argv: string[]): { command: string | null; flags: Record<string, string | boolean> } {
  const flags: Record<string, string | boolean> = {};
  let command: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2);
      if (inline !== undefined) flags[k] = inline;
      else if (['setup', 'web-agent', 'operations', 'api', 'url'].includes(k)) flags[k] = argv[++i] ?? '';
      else flags[k] = true;
    } else if (!command) command = a;
    else throw usageError(`Unexpected argument "${a}".`);
  }
  return { command, flags };
}

async function main(): Promise<number> {
  const { command, flags } = parse(process.argv.slice(2));
  const mode = resolveMode({ json: flags.json === true, quiet: flags.quiet === true });
  try {
    if (flags.version) {
      emit(mode, { version: VERSION }, () => VERSION);
      return EXIT.OK;
    }
    if (!command || flags.help) {
      emit(mode, { help: HELP }, () => HELP);
      return command ? EXIT.OK : EXIT.USAGE;
    }
    if (command === 'init' || command === 'sync') {
      const check = command === 'sync' && flags.check === true;
      const result = await runInit({
        cwd: process.cwd(),
        setup: typeof flags.setup === 'string' ? flags.setup : null,
        webAgent: typeof flags['web-agent'] === 'string' ? flags['web-agent'] : null,
        api: typeof flags.api === 'string' ? flags.api : null,
        operations: typeof flags.operations === 'string' ? flags.operations.split(',').map((s) => s.trim()).filter(Boolean) : null,
        dryRun: flags['dry-run'] === true || check,
        yes: flags.yes === true,
        interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        source: command,
      });
      emit(mode, result, () => describeInit(result));
      if (check && syncCheckDrifted(result)) return EXIT.USAGE;
      return EXIT.OK;
    }
    if (command === 'doctor') {
      const result = await runDoctor({ cwd: process.cwd(), url: typeof flags.url === 'string' && flags.url ? flags.url : 'http://localhost:3000' });
      emit(mode, result, () => describeDoctor(result));
      return result.findings.some((f) => f.level === 'error') ? EXIT.UPSTREAM : EXIT.OK;
    }
    throw usageError(`Unknown command "${command}". ${HELP}`);
  } catch (err) {
    const e = err instanceof CliError ? err : new CliError('internal', err instanceof Error ? err.message : String(err), EXIT.UPSTREAM);
    emitError(mode, e);
    return e.exitCode;
  }
}

declare const __FAUSTINE_NEXT_VERSION__: string | undefined;
const VERSION = typeof __FAUSTINE_NEXT_VERSION__ === 'string' ? __FAUSTINE_NEXT_VERSION__ : '0.0.0-dev';

main().then((code) => process.exit(code));
