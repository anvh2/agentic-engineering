import { realpathSync } from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { redact } from './coding-task-trace.ts';

/**
 * Verifier output is an INPUT to the next worker attempt (the retry prompt, the REPAIR feedback) and, for Codex, it is sent to a cloud
 * provider. The verifier executes worker-written code, which can print anything it can see: the read allow-list of the verifier sandbox
 * (sandbox.ts) keeps credentials and unrelated files out of its reach, but it still sees its own environment, the host name that `uname`
 * returns, the paths it runs in and the toolchain. This is the second control on that channel: before output reaches a worker it is
 *
 *   1. stripped of terminal escapes and control characters (no hidden instructions, no cursor tricks);
 *   2. redacted for token shapes and secret-named environment values (`redact`);
 *   3. rewritten so that host identity does not travel: the repository path becomes `<repo>`, temp directories `<tmp>`, the home directory
 *      `<home>`, the user name `<user>`, the host name `<host>`, and any other absolute path into a user, volume, Homebrew or system
 *      location `<host-path>`.
 *
 * What it does not do: judge whether text is "sensitive" in general. A failing assertion still prints its own values: that is the message
 * the worker needs. The guarantee is about the host, not about the repository's own content.
 */

export interface ScrubOptions {
  /** Paths that name the task's own world, longest first wins: `{ '/abs/worktree': '<repo>' }`. */
  roots?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
/** Absolute paths into places that identify a host or a user. Left alone: `/usr/bin/...`, `/dev/...`. */
const HOST_PATH = /(?<![\w<./-])\/(?:Users|home|Volumes|private|var|opt|Applications|Library|System|usr\/local|root|tmp|etc)\/[^\s:'"<>)\]},;]*/g;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

function replacements(options: ScrubOptions): [string, string][] {
  const pairs = new Map<string, string>();
  const add = (value: string | undefined, label: string) => {
    if (value && value.length >= 3 && value !== '/') pairs.set(value, label);
  };
  for (const [path, label] of Object.entries(options.roots ?? {})) {
    add(path, label);
    add(real(path), label);
  }
  add(real(tmpdir()), '<tmp>');
  add(tmpdir(), '<tmp>');
  const home = real(homedir());
  add(home, '<home>');
  add(homedir(), '<home>');
  return [...pairs].sort((a, b) => b[0].length - a[0].length);
}

export function scrubForWorker(text: string, options: ScrubOptions = {}): string {
  const env = options.env ?? process.env;
  let out = text.replace(ANSI, '').replace(CONTROL, ' ');
  out = redact(out, env);
  for (const [value, label] of replacements(options)) out = out.split(value).join(label);
  const names = new Set<string>();
  try {
    names.add(userInfo().username);
  } catch {
    /* no passwd entry */
  }
  for (const n of [env.USER, env.LOGNAME]) if (n) names.add(n);
  for (const name of names) if (name.length >= 3) out = out.replace(new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(name)}(?![A-Za-z0-9_-])`, 'g'), '<user>');
  const host = hostname();
  for (const h of new Set([host, host.split('.')[0]])) if (h.length >= 3) out = out.replace(new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(h)}(?![A-Za-z0-9_-])`, 'gi'), '<host>');
  out = out.replace(HOST_PATH, '<host-path>');
  return out;
}
