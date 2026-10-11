import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';

/**
 * Which directories a coding toolchain needs READABLE, found by the trusted side (never from a worktree: a worker controls what is
 * inside it). Shared by the verifier sandbox (sandbox.ts) and the Codex isolation profile (workers/providers/codex-isolation.ts).
 */

/** A path as a sandbox profile and TOML key quoting can carry it. Anything else is refused, never escaped. */
export const SAFE_PATH = /^\/[^\0-\x1f"'\\=]+$/;
/** Directories far too wide to ever be granted. */
export const TOO_BROAD = new Set(['/', '/usr', '/usr/local', '/opt', '/opt/homebrew', '/Users', '/home', '/Library', '/System', '/private', '/var', '/etc', '/Applications', '/bin', '/sbin', '/tmp']);

/** The path the sandbox will see: symlinks resolved when it exists (macOS /var -> /private/var), the path itself otherwise. */
export function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}
export const isInside = (child: string, parent: string): boolean => child === parent || child.startsWith(`${parent}/`);

export const which = (tool: string, pathVar: string | undefined): string | undefined => {
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, tool);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* next */
    }
  }
  return undefined;
};

/** Adds a path to `found` only if it is safe to grant: expressible, specific, existing, and neither inside nor above the home directory. */
function adder(env: NodeJS.ProcessEnv, found: Set<string>, options: { allowInsideHome?: boolean } = {}) {
  const home = canonicalPath(env.HOME ?? homedir());
  return (p: string | undefined) => {
    if (!p) return;
    const real = canonicalPath(p);
    if (!SAFE_PATH.test(real) || TOO_BROAD.has(real) || !existsSync(real)) return;
    if (isInside(home, real)) return; // the home directory itself or anything above it
    if (!options.allowInsideHome && real.startsWith(`${home}/`)) return;
    found.add(real);
  };
}

const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv): string | undefined => {
  try {
    return execFileSync(cmd, args, { env, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
};

const SYSTEM_BIN = /^\/(usr\/bin|bin|usr\/sbin|sbin)\//;
const KEG = /^(\/(?:opt\/homebrew|usr\/local)\/Cellar\/[^/]+\/[^/]+)\//;

/** The one NVM installation version containing `path`, never NVM_DIR or HOME. */
export function nvmNodeVersionRoot(path: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const nvm = canonicalPath(env.NVM_DIR ?? join(env.HOME ?? homedir(), '.nvm'));
  const versions = join(nvm, 'versions', 'node');
  const real = canonicalPath(path);
  if (!real.startsWith(`${versions}/`)) return undefined;
  const version = real.slice(versions.length + 1).split('/')[0];
  if (!version || version === '.' || version === '..') return undefined;
  return join(versions, version);
}

/** Read access needed for a trusted launcher to re-exec itself inside its child sandbox. */
export function executableReadPaths(command: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const path = command.includes('/') ? command : which(command, env.PATH);
  if (!path) return [];
  const real = canonicalPath(path);
  if (SYSTEM_BIN.test(real)) return [];
  const nvm = nvmNodeVersionRoot(path, env) ?? nvmNodeVersionRoot(real, env);
  // An NVM command is a script plus the Node interpreter and package files in this one version. Native launchers need only
  // their resolved executable, not their containing bin directory (which could expose unrelated tools).
  if (nvm) return [nvm];
  const home = canonicalPath(env.HOME ?? homedir());
  return !real.startsWith(`${home}/`) && real !== home && SAFE_PATH.test(real) && existsSync(real) ? [real] : [];
}

/**
 * The directories a coding toolchain needs to be READABLE inside the Codex sandbox, found from PATH by the trusted launcher: each tool's
 * directory, its package root (a Homebrew keg, `/usr/local/go`), GOROOT, and the Xcode command-line-tools directory the `git` shim
 * needs. Anything too broad (`/opt/homebrew`, `/usr/local`, a home directory) is dropped, never granted.
 */
export function discoverToolchainReadPaths(options: { tools?: readonly string[]; env?: NodeJS.ProcessEnv } = {}): string[] {
  // Default: the Go toolchain only. `git` is not offered by default: inside an isolated worktree its git directory is unreadable, so the
  // worker cannot use it, and its Xcode shim would put the whole command-line-tools directory (python, swift, clang) in reach.
  const env = options.env ?? process.env;
  const found = new Set<string>();
  const add = adder(env, found);
  for (const tool of options.tools ?? ['go', 'gofmt']) {
    const path = which(tool, env.PATH);
    if (!path) continue;
    add(dirname(path));
    const real = canonicalPath(path);
    const keg = real.match(KEG);
    if (keg) add(keg[1]);
    else if (!SYSTEM_BIN.test(real)) add(dirname(dirname(real)));
  }
  const toolEnv = { PATH: env.PATH ?? '', GOTOOLCHAIN: 'local', GOFLAGS: '' };
  if (which('go', env.PATH)) add(run('go', ['env', 'GOROOT'], toolEnv));
  const xcode = which('xcode-select', env.PATH) ? run('xcode-select', ['-p'], toolEnv) : undefined;
  if (xcode && which('git', env.PATH) && canonicalPath(which('git', env.PATH)!).startsWith('/usr/bin/')) add(xcode);
  return [...found].sort();
}

export interface ExecutableAccess {
  /** Directories the executable and its toolchain need readable (never the home directory or anything above it, except the Go module cache). */
  read: string[];
  /** Directories that go on the command's PATH, in order. */
  binDirs: string[];
  /** Fixed environment entries the toolchain needs (the Go module cache location). */
  env: Record<string, string>;
}

const cache = new Map<string, ExecutableAccess>();

/**
 * What ONE executable needs, for the verifier sandbox. Go and gofmt: their own package root, GOROOT and the module cache (dependencies
 * of the repository are resolved offline from it; it holds third-party module source and no credentials). Everything else found under a
 * Homebrew prefix (node, npx, ...): the prefix's package directories, because such binaries link libraries from sibling packages, plus
 * the OpenSSL configuration node reads at start-up. Cached per executable for the life of the process.
 */
export function executableAccess(exe: string, env: NodeJS.ProcessEnv = process.env): ExecutableAccess {
  const hit = cache.get(exe);
  if (hit) return hit;
  const read = new Set<string>();
  const add = adder(env, read);
  const addInsideHome = adder(env, read, { allowInsideHome: true });
  const name = basename(exe);
  const real = canonicalPath(exe);
  const binDirs = [...new Set([dirname(exe), dirname(real)].filter((d) => SAFE_PATH.test(d)))];
  const fixed: Record<string, string> = {};
  const goFamily = name === 'go' || name === 'gofmt';
  const keg = real.match(KEG);
  if (!SYSTEM_BIN.test(real)) {
    // NVM is commonly inside HOME. Grant only the exact installed Node version that owns the trusted executable; this includes
    // node plus npm/npx's package files without exposing NVM_DIR, sibling versions, HOME, or credential directories.
    addInsideHome(nvmNodeVersionRoot(exe, env) ?? nvmNodeVersionRoot(real, env));
    if (keg) add(keg[1]);
    else add(dirname(dirname(real)));
    // `npx` is a symlink into the npm package directory, `node` is a keg: look at where the command was FOUND as well as where it resolves
    const prefix = [exe, real].map((p) => p.match(/^(\/opt\/homebrew|\/usr\/local)\//)?.[1]).find(Boolean);
    if (prefix && !goFamily) {
      for (const d of ['Cellar', 'opt', 'bin', 'lib', 'etc/openssl@3']) add(`${prefix}/${d}`);
    }
  }
  if (goFamily) {
    const goBin = name === 'go' ? exe : which('go', env.PATH) ?? join(dirname(exe), 'go');
    const out = run(goBin, ['env', 'GOROOT', 'GOMODCACHE'], { PATH: env.PATH ?? '', HOME: env.HOME ?? homedir(), GOTOOLCHAIN: 'local', GOFLAGS: '', ...(env.GOPATH ? { GOPATH: env.GOPATH } : {}), ...(env.GOMODCACHE ? { GOMODCACHE: env.GOMODCACHE } : {}) });
    const [goroot, modcache] = (out ?? '').split('\n');
    add(goroot);
    if (modcache && SAFE_PATH.test(modcache)) {
      const mod = canonicalPath(modcache);
      // the one place under the home directory a toolchain legitimately needs: read-only module source, and never the home directory itself
      const home = canonicalPath(env.HOME ?? homedir());
      if (existsSync(mod) && !isInside(home, mod)) {
        read.add(mod);
        fixed.GOMODCACHE = mod;
      }
    }
  }
  const result: ExecutableAccess = { read: [...read].sort(), binDirs, env: fixed };
  cache.set(exe, result);
  return result;
}

/** Tests only. */
export function resetToolchainCacheForTests(): void {
  cache.clear();
}
