import { homedir } from 'node:os';
import { join } from 'node:path';
import { SAFE_PATH, TOO_BROAD, canonicalPath, discoverToolchainReadPaths, isInside } from '../../runtime/sandbox/toolchain.ts';

export { canonicalPath, discoverToolchainReadPaths, isInside };

/**
 * What the model's commands may read, write and see when Codex runs as a coding worker. Codex executes model-issued shell commands
 * itself, on the host, as the user: without this, anything the user can read (SSH keys, cloud credentials, the Codex login, shell
 * history, the oracle) is one `cat` away, and ends up in the model provider's logs. Four independent layers, each tested against the
 * real CLI (tests/provider-smoke/read-isolation-canary.ts):
 *
 *  1. FILESYSTEM ALLOW-LIST. The profile starts from the CLI's `:minimal` read set (system binaries and libraries) and adds only the
 *     toolchain directories named in `readAllowPaths`. Everything else on the host, the whole home directory included, is unreadable.
 *     Writes: the worktree and the per-call scratch directory (not the shared temp dirs); `.git` and `.codex` stay read-only.
 *  2. EXPLICIT DENIALS on top: the credential locations below plus any `denyReadPaths` (oracle, runtime state). In allow-list mode
 *     they are redundant by construction; they are what protects a deny-list-only configuration and a mistaken allow-list.
 *  3. ENVIRONMENT. Codex's default policy hands the model's commands EVERY variable of the launcher, secrets and `SSH_AUTH_SOCK`
 *     included. The run pins `inherit="core"` (PATH, locale, terminal...) plus a fixed set: HOME and the Go/git cache variables point
 *     into a per-call scratch directory, git ignores every config file, Go cannot download.
 *  4. TOOL SURFACE. Of the ~20 tools the CLI offers the model, three remain: `exec_command`, `write_stdin`, `request_user_input`.
 *     Apps, sub-agents, plugins, browser and computer use, image tools and web search are disabled, and `--strict-config` makes the CLI
 *     refuse a setting it does not know instead of ignoring it, so a CLI that drops one of these switches fails closed.
 *
 * What this does NOT do: see docs/reports/m8.7a-credential-isolation.md ("Remaining exposure").
 */

export const CODEX_ISOLATION_PROFILE = 'agentic-isolated';

/** The only tools the model may be offered. The canary compares the CLI's real tool list with this and fails on anything else. */
export const CODEX_AUDITED_TOOLS: readonly string[] = ['exec_command', 'write_stdin', 'request_user_input'];

/** Switches that remove every other tool. Each name is checked by the CLI itself: an unknown feature or setting is an error. */
export const CODEX_TOOL_SURFACE_ARGS: readonly string[] = [
  '--strict-config',
  ...['apps', 'multi_agent', 'goals', 'plugins', 'remote_plugin', 'browser_use', 'computer_use', 'image_generation'].flatMap((f) => ['--disable', f]),
  '-c', 'web_search="disabled"',
  '-c', 'features.view_image=false',
];

export function checkIsolationPaths(paths: readonly string[], label: string): string[] {
  for (const p of paths) {
    if (!SAFE_PATH.test(p) || p === '/' || p.endsWith('/') || p.split('/').some((seg) => seg === '..' || seg === '.')) throw new Error(`codex ${label}: "${p}" is not an absolute, normalized path without quotes, backslashes or control characters`);
  }
  return [...paths];
}

/**
 * Credential and secret locations of a user account, relative to HOME. Paths that do not exist are harmless in the profile. Not a
 * complete list and not meant to be: in allow-list mode nothing under HOME is readable at all; this list protects a deny-list-only
 * configuration and a mistaken allow-list entry.
 */
const HOME_CREDENTIALS = [
  '.ssh', '.aws', '.gnupg', '.azure', '.oci', '.kube', '.docker', '.terraform.d', '.vault-token', '.netrc', '.npmrc', '.yarnrc', '.pypirc', '.git-credentials', '.gem/credentials',
  '.config/gcloud', '.config/gh', '.config/op', '.config/git', '.config/helm', '.config/doctl', '.config/heroku', '.config/stripe', '.config/configstore', '.cache/gh',
  '.codex', '.claude', '.claude.json', '.antigravity', '.cursor', '.gemini', '.config/anthropic', '.config/openai', '.openai',
  '.bash_history', '.zsh_history', '.zsh_sessions', '.python_history', '.node_repl_history', '.psql_history', '.mysql_history', '.lesshst',
  'google-cloud-sdk/.install', 'Library/Keychains', 'Library/Cookies', 'Library/Application Support/Google/Chrome', 'Library/Application Support/Firefox',
  'Library/Application Support/com.apple.sharedfilelist', 'Library/Application Support/1Password', 'Library/Application Support/Code/User/globalStorage', 'Library/Messages', 'Library/Mail',
];

export function credentialDenyPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = canonicalPath(env.HOME ?? homedir());
  const out = new Set<string>(HOME_CREDENTIALS.map((r) => join(home, r)));
  // The launcher's own login. The launcher (not sandboxed) still reads it; only the model's commands lose access.
  const codexHome = env.CODEX_HOME ? canonicalPath(env.CODEX_HOME) : join(home, '.codex');
  out.add(codexHome);
  return [...out].filter((p) => SAFE_PATH.test(p)).sort();
}

export interface CodexIsolationOptions {
  /** Allow-list mode when defined (even empty): the model's commands can read ONLY the system minimum plus these and the worktree. */
  readAllowPaths?: readonly string[];
  /** Extra paths made unreadable (the oracle, runtime state). Credential locations are always added. */
  denyReadPaths?: readonly string[];
  /** Per-call scratch directory: HOME, TMPDIR and the Go/XDG caches of the model's commands. Writable. Must already exist. */
  scratchDir?: string;
  /** Where HOME / CODEX_HOME are, for the credential list (default: process.env). */
  env?: NodeJS.ProcessEnv;
}

export const isolationRequested = (o: { readAllowPaths?: readonly string[]; denyReadPaths?: readonly string[] }): boolean => o.readAllowPaths !== undefined || (o.denyReadPaths?.length ?? 0) > 0;

/** Shared temp directories the CLI's `:minimal` read set includes. Other programs leave user-readable files there. */
const SHARED_TEMP_DIRS = ['/private/tmp', '/private/var/tmp'];

/**
 * The deny list the profile will carry: the explicit paths, the credential locations and, in allow-list mode, the shared temp directories
 * (the worker has its own scratch directory), deduplicated.
 */
export function effectiveDenyPaths(o: CodexIsolationOptions): string[] {
  return [...new Set([...checkIsolationPaths(o.denyReadPaths ?? [], 'denyReadPaths'), ...credentialDenyPaths(o.env), ...(o.readAllowPaths !== undefined ? SHARED_TEMP_DIRS : [])])].sort();
}

/**
 * Throws unless the allow-list is safe to hand to the sandbox: every entry specific enough, and none of them containing a denied path
 * (an allow entry above `~/.ssh` would only be saved by the explicit denial; a configuration that needs saving is refused instead).
 */
export function checkReadAllowPaths(allow: readonly string[], deny: readonly string[]): string[] {
  const paths = checkIsolationPaths(allow, 'readAllowPaths');
  for (const a of paths) {
    if (TOO_BROAD.has(a)) throw new Error(`codex readAllowPaths: "${a}" is too broad to grant`);
    const exposed = deny.find((d) => isInside(d, a));
    if (exposed) throw new Error(`codex readAllowPaths: "${a}" would contain the protected path ${exposed}`);
  }
  return paths;
}

/** The environment of the model's commands: nothing inherited but the core set, everything else fixed. */
export function shellEnvironment(scratchDir: string): Record<string, string> {
  checkIsolationPaths([scratchDir], 'scratchDir');
  return {
    HOME: scratchDir,
    TMPDIR: scratchDir,
    XDG_CACHE_HOME: `${scratchDir}/cache`,
    XDG_CONFIG_HOME: `${scratchDir}/config`,
    GOCACHE: `${scratchDir}/go-build`,
    GOPATH: `${scratchDir}/go`,
    GOTOOLCHAIN: 'local',
    GOPROXY: 'off',
    GOTELEMETRY: 'off',
    GOFLAGS: '-buildvcs=false',
    CGO_ENABLED: '0',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/** The profile's filesystem table, as the inline TOML value of `permissions.<name>.filesystem`. */
export function isolationFilesystemTable(o: CodexIsolationOptions): string {
  const deny = effectiveDenyPaths(o);
  const allowMode = o.readAllowPaths !== undefined;
  const allow = allowMode ? checkReadAllowPaths(o.readAllowPaths ?? [], deny) : [];
  const entries = [
    allowMode ? '":minimal"="read"' : '":root"="read"',
    '":project_roots"={"."="write", ".git"="read", ".codex"="read"}',
    // The shared temp dirs hold other programs' files (sockets, exports, tokens). Allow-list mode grants only this call's scratch directory;
    // the deny-list mode keeps them because it already reads everything else.
    ...(allowMode ? [] : ['":tmpdir"="write"', '":slash_tmp"="write"']),
    ...(o.scratchDir ? [`"${checkIsolationPaths([o.scratchDir], 'scratchDir')[0]}"="write"`] : []),
    ...allow.map((p) => `"${p}"="read"`),
    ...deny.map((p) => `"${p}"="none"`),
  ];
  return `{${entries.join(', ')}}`;
}

/** Every `-c` / `--disable` argument an isolated run adds: tool surface, shell environment, permission profile. Nothing free-form. */
export function isolationArgs(o: CodexIsolationOptions): string[] {
  const env = o.scratchDir ? shellEnvironment(o.scratchDir) : undefined;
  const setTable = env ? `{${Object.entries(env).map(([k, v]) => `${k}="${v}"`).join(', ')}}` : undefined;
  return [
    ...CODEX_TOOL_SURFACE_ARGS,
    '-c', 'shell_environment_policy.inherit="core"',
    ...(setTable ? ['-c', `shell_environment_policy.set=${setTable}`] : []),
    '-c', `default_permissions="${CODEX_ISOLATION_PROFILE}"`,
    '-c', `permissions.${CODEX_ISOLATION_PROFILE}.filesystem=${isolationFilesystemTable(o)}`,
  ];
}
