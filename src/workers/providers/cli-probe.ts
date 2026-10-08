import type { ProviderAvailability } from '../../runtime/execution/worker-provider.ts';
import { runProviderProcess } from './process.ts';

/**
 * Availability of a provider CLI, decided from the installed binary's own answers and nothing else. It never returns,
 * logs or stores a credential or account identifier: the auth check yields a yes/no, not the CLI's output.
 *
 * Safety flags are verified against the installed version's `--help`, not assumed from documentation or from another
 * CLI. A required flag the installed version does not advertise makes the provider unavailable (fail closed): a
 * restriction the CLI cannot enforce is a restriction the runtime does not have.
 */

export interface CliProbeSpec {
  command: string;
  cwd: string;
  versionArgs: string[];
  /** Command line whose output lists the flags used for a run. */
  helpArgs: string[];
  /** Flags that must appear in the help output for the provider to be usable at all. */
  requiredFlags: readonly string[];
  /** Exit status 0 means signed in. Absent: auth cannot be checked and the probe reports it as unknown rather than guessing. */
  authArgs?: string[];
  parentEnv?: NodeJS.ProcessEnv;
  /** Parent variable names the CLI needs (never values): the CLI's own home/config dir, not API keys unless the user chose that. */
  passEnv?: readonly string[];
  /** Fixed variables for every probe process. */
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface CliProbeResult extends ProviderAvailability {
  /** Flags from `requiredFlags` the installed version does not advertise. */
  missingFlags: string[];
  /** Flags a caller may use only if present (computed against the same help text). */
  advertises: (flag: string) => boolean;
}

const hasFlag = (help: string, flag: string) => new RegExp(`(^|[\\s,\\[|])${flag.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}([\\s=,\\]|<]|$)`, 'm').test(help);

export async function probeCli(spec: CliProbeSpec): Promise<CliProbeResult> {
  const base = { cwd: spec.cwd, timeoutMs: spec.timeoutMs ?? 10_000, termGraceMs: 500, killWaitMs: 1_000, parentEnv: spec.parentEnv, passEnv: spec.passEnv, env: spec.env };
  const never = (state: ProviderAvailability['state'], detail: string, version?: string, missingFlags: string[] = []): CliProbeResult => ({ state, detail, version, missingFlags, advertises: () => false });

  const v = await runProviderProcess({ command: spec.command, args: spec.versionArgs, ...base });
  if (v.spawnError || v.exitCode === null) return never('not_installed', `${spec.command} is not installed or not runnable${v.spawnError ? ` (${v.spawnError})` : ''}`);
  if (v.exitCode !== 0) return never('unavailable', `${spec.command} ${spec.versionArgs.join(' ')} exited ${v.exitCode}`);
  const version = (v.stdout || v.stderr).trim().split('\n')[0]?.slice(0, 80);

  const h = await runProviderProcess({ command: spec.command, args: spec.helpArgs, ...base });
  const help = `${h.stdout}\n${h.stderr}`;
  if (h.exitCode !== 0 || !help.trim()) return never('unsupported_version', `${spec.command} ${spec.helpArgs.join(' ')} did not print usage; cannot confirm the safety flags`, version);
  const advertises = (flag: string) => hasFlag(help, flag);
  const missing = spec.requiredFlags.filter((f) => !advertises(f));
  if (missing.length > 0) return { state: 'unsupported_version', detail: `installed ${version ?? spec.command} does not advertise required flag(s): ${missing.join(', ')}; refusing to run without them`, version, missingFlags: missing, advertises };

  if (spec.authArgs) {
    const a = await runProviderProcess({ command: spec.command, args: spec.authArgs, ...base });
    if (a.exitCode !== 0) return { state: 'not_authenticated', detail: `${spec.command} ${spec.authArgs.join(' ')} reports no active session`, version, missingFlags: [], advertises };
    return { state: 'available', detail: `${version ?? spec.command}; required flags present; a session is active`, version, missingFlags: [], advertises };
  }
  return { state: 'available', detail: `${version ?? spec.command}; required flags present; sign-in state could not be checked`, version, missingFlags: [], advertises };
}
