import { createTool } from '@mastra/core/tools';
import { spawn } from 'node:child_process';
import { relative } from 'node:path';
import { z } from 'zod';
import { getRepositoryRoot, resolveWithinRepository, resolveWritablePathWithinRepository } from './repository-tools.ts';
import { runSandboxedCommand } from '../../runtime/sandbox/sandbox.ts';

/**
 * Controlled command execution for the coding worker's verify/repair loop
 * (Step 12). Every tool here spawns one fixed, non-shell binary with an
 * argument array built entirely by this module - the model only ever
 * supplies narrow, validated data (a Go package selector, a file path), and
 * that data can never reach a shell for interpretation. There is
 * deliberately no generic exec/shell/spawn tool: the worker's only
 * execution capabilities are the ones exported below.
 *
 * Everything that executes repository code (go test, jest, and the formatters, which load repo config) runs inside the
 * OS sandbox (../sandbox/sandbox.ts): writes limited to the repository, no network, no harness secrets. If isolation
 * is unavailable these tools refuse to run. git here is the harness's own binary on the harness's own terms.
 */

const MAX_OUTPUT_BYTES = 4_000;

// Read fresh on every call rather than cached at module load, so timeouts
// stay configurable per-run (and so tests can exercise the timeout path by
// setting the env var right before calling a tool, without needing a
// separate process per test file).
function goTestTimeoutMs(): number {
  return Number(process.env.GO_TEST_TIMEOUT_MS) || 60_000;
}
function goFmtTimeoutMs(): number {
  return Number(process.env.GO_FMT_TIMEOUT_MS) || 10_000;
}
function jestTestTimeoutMs(): number {
  return Number(process.env.JEST_TEST_TIMEOUT_MS) || 60_000;
}
function prettierTimeoutMs(): number {
  return Number(process.env.PRETTIER_TIMEOUT_MS) || 10_000;
}
function gitCommandTimeoutMs(): number {
  return Number(process.env.GIT_COMMAND_TIMEOUT_MS) || 10_000;
}

export interface ControlledCommandResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) return { text, truncated: false };
  return {
    text: `${buffer.subarray(0, maxBytes).toString('utf8')}\n\n[output truncated; additional output was produced]`,
    truncated: true,
  };
}

/**
 * Spawns `command` with a fixed argv array (never a shell string) inside
 * `cwd`, enforcing a hard timeout and bounded output capture. On timeout,
 * the entire process group is killed (not just the direct child) so a
 * runaway `go test` can't leave orphaned test binaries behind - `detached:
 * true` gives the child its own process group, and a negative pid targets
 * that whole group with SIGKILL.
 */
export function runControlledCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<ControlledCommandResult> {
  const start = Date.now();

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        ...(options.env ? { env: options.env } : {}),
      });
    } catch (err) {
      resolve({
        success: false,
        exitCode: null,
        stdout: '',
        stderr: `Failed to start "${command}": ${(err as Error).message}`,
        durationMs: Date.now() - start,
        timedOut: false,
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      } else {
        child.kill('SIGKILL');
      }
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes < MAX_OUTPUT_BYTES * 2) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.byteLength;
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes < MAX_OUTPUT_BYTES * 2) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.byteLength;
      }
    });

    const finish = (result: ControlledCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on('error', (err) => {
      finish({
        success: false,
        exitCode: null,
        stdout: truncate(Buffer.concat(stdoutChunks).toString('utf8'), MAX_OUTPUT_BYTES).text,
        stderr: `Failed to run "${command}": ${err.message}`,
        durationMs: Date.now() - start,
        timedOut: false,
      });
    });

    child.on('close', (code) => {
      const { text: stdout } = truncate(Buffer.concat(stdoutChunks).toString('utf8'), MAX_OUTPUT_BYTES);
      let { text: stderr } = truncate(Buffer.concat(stderrChunks).toString('utf8'), MAX_OUTPUT_BYTES);
      if (timedOut) {
        stderr += `\n[Command timed out after ${options.timeoutMs}ms and was terminated.]`;
      }
      finish({
        success: !timedOut && code === 0,
        exitCode: timedOut ? null : code,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}

// Deliberately restrictive: only a leading "./" path made of plain segment
// characters, optionally ending in a literal "...". No "..", no absolute
// paths, no shell metacharacters (;, |, &, $, `, <, >, whitespace) - the
// charset itself makes injection impossible without needing to blocklist
// anything. Kept as a whole-string anchor (^...$) with no unbounded
// backtracking (linear segments), so it's also not a ReDoS surface.
const GO_PACKAGE_PATTERN = /^\.\/(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*(?:\.\.\.|[A-Za-z0-9_][A-Za-z0-9_.-]*)$/;

function validateGoPackage(pkg: string): void {
  if (pkg.length > 200 || !GO_PACKAGE_PATTERN.test(pkg)) {
    throw new Error(
      `"${pkg}" is not a valid package selector. Use a relative pattern like "./...", "./internal/foo", or "./internal/foo/...".`,
    );
  }
}

export const runGoTest = createTool({
  id: 'runGoTest',
  description: 'Run `go test` for a package selector like "./..." or "./internal/foo". No shell syntax accepted.',
  inputSchema: z.object({
    package: z.string().optional().describe('e.g. "./...", "./internal/foo". Defaults to "./...".'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    exitCode: z.number().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number(),
    timedOut: z.boolean(),
  }),
  execute: async ({ package: pkg }, { requestContext }) => {
    const root = getRepositoryRoot(requestContext);
    const selector = pkg && pkg.trim() !== '' ? pkg.trim() : './...';
    validateGoPackage(selector);

    return runSandboxedCommand('go', ['test', selector], {
      cwd: root,
      root,
      timeoutMs: goTestTimeoutMs(),
    });
  },
});

export const runGoFmt = createTool({
  id: 'runGoFmt',
  description: 'Format one Go file in place with gofmt; reports whether it changed.',
  inputSchema: z.object({
    path: z.string().describe('Path to the Go file, relative to repo root.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    path: z.string(),
    changed: z.boolean(),
    stderr: z.string(),
  }),
  execute: async ({ path }, { requestContext }) => {
    const root = getRepositoryRoot(requestContext);
    const target = await resolveWritablePathWithinRepository(root, path);

    const before = await runSandboxedCommand('gofmt', ['-l', target], {
      cwd: root,
      root,
      timeoutMs: goFmtTimeoutMs(),
    });
    if (!before.success) {
      // gofmt -l fails (non-zero / stderr) on invalid Go source rather than
      // rewriting it - surface that cleanly instead of attempting -w.
      return { success: false, path, changed: false, stderr: before.stderr || before.stdout };
    }
    const alreadyFormatted = before.stdout.trim() === '';

    if (alreadyFormatted) {
      return { success: true, path, changed: false, stderr: '' };
    }

    const result = await runSandboxedCommand('gofmt', ['-w', target], {
      cwd: root,
      root,
      timeoutMs: goFmtTimeoutMs(),
    });

    return { success: result.success, path, changed: result.success, stderr: result.stderr };
  },
});

// --- JS/Node ecosystem equivalents (a codingWorker configured for a JS
// repository gets these instead of the Go tools above; never both - see
// createCodingWorker in agents/coding-worker.ts). Same shared
// runControlledCommand/boundary-check plumbing as the Go tools; only the
// spawned binary and argument shape differ.

export const runJestTest = createTool({
  id: 'runJestTest',
  description:
    'Run `npx jest` scoped to a test file or directory (relative to repo root). Prefer scoping to the file/directory you touched rather than the whole suite. Omit testPath to run everything.',
  inputSchema: z.object({
    testPath: z
      .string()
      .optional()
      .describe('e.g. "src/library/util/tests/unit/util.foo.test.js" or a directory. Omit to run the full suite.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    exitCode: z.number().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number(),
    timedOut: z.boolean(),
  }),
  execute: async ({ testPath }, { requestContext }) => {
    const root = getRepositoryRoot(requestContext);
    // --no-install: without a TTY npx would otherwise silently download and run the package from the registry.
    const args = ['--no-install', 'jest', '--ci'];

    if (testPath && testPath.trim() !== '') {
      // Boundary-checked the same way gitStatus/gitDiff scope their optional
      // path - reused rather than re-validated, since a jest test selector
      // is a literal repository path, not a build-pattern string like Go's
      // package selector.
      const target = await resolveWithinRepository(root, testPath);
      const selector = relative(root, target) || '.';
      // A file named like "--config=x.js" would otherwise reach jest as an option (and --config runs arbitrary code).
      if (selector.startsWith('-')) throw new Error(`Test path "${testPath}" must not start with "-" (it would be read as a jest option).`);
      args.push(selector);
    }

    return runSandboxedCommand('npx', args, { cwd: root, root, timeoutMs: jestTestTimeoutMs() });
  },
});

export const runPrettier = createTool({
  id: 'runPrettier',
  description:
    'Format one file in place with prettier (--write); reports whether it changed. Use this only on a file you just created or fully rewrote - this repository is not prettier-clean throughout, so running it on a pre-existing file you only partially edited can produce a large, unrelated reformatting diff.',
  inputSchema: z.object({
    path: z.string().describe('Path to the file, relative to repo root.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    path: z.string(),
    changed: z.boolean(),
    stderr: z.string(),
  }),
  execute: async ({ path }, { requestContext }) => {
    const root = getRepositoryRoot(requestContext);
    const target = await resolveWritablePathWithinRepository(root, path);

    const before = await runSandboxedCommand('npx', ['--no-install', 'prettier', '--check', target], {
      cwd: root,
      root,
      timeoutMs: prettierTimeoutMs(),
    });
    if (before.success) {
      return { success: true, path, changed: false, stderr: '' };
    }

    const result = await runSandboxedCommand('npx', ['--no-install', 'prettier', '--write', target], {
      cwd: root,
      root,
      timeoutMs: prettierTimeoutMs(),
    });
    // A genuine parse error (not just "unformatted") surfaces here as a
    // non-zero exit from `--write` too - reported cleanly rather than
    // conflated with "successfully reformatted".
    return { success: result.success, path, changed: result.success, stderr: result.stderr };
  },
});

function relativeGitPath(root: string, resolvedTarget: string): string {
  const rel = relative(root, resolvedTarget);
  return rel === '' ? '.' : rel;
}

export const gitStatus = createTool({
  id: 'gitStatus',
  description: 'Show which files changed (read-only, `git status --short`).',
  inputSchema: z.object({
    path: z.string().optional().describe('Optional path to scope to.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    stdout: z.string(),
    stderr: z.string(),
  }),
  execute: async ({ path }, { requestContext }) => {
    const root = getRepositoryRoot(requestContext);
    const target = await resolveWithinRepository(root, path);
    const scope = relativeGitPath(root, target);

    const result = await runControlledCommand('git', ['status', '--short', '--', scope], {
      cwd: root,
      timeoutMs: gitCommandTimeoutMs(),
    });
    return { success: result.success, stdout: result.stdout, stderr: result.stderr };
  },
});

export const gitDiff = createTool({
  id: 'gitDiff',
  description: 'Show uncommitted changes to tracked files (read-only, `git diff`).',
  inputSchema: z.object({
    path: z.string().optional().describe('Optional path to scope to.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    stdout: z.string(),
    stderr: z.string(),
  }),
  execute: async ({ path }, { requestContext }) => {
    const root = getRepositoryRoot(requestContext);
    const target = await resolveWithinRepository(root, path);
    const scope = relativeGitPath(root, target);

    const result = await runControlledCommand('git', ['diff', '--', scope], {
      cwd: root,
      timeoutMs: gitCommandTimeoutMs(),
    });
    return { success: result.success, stdout: result.stdout, stderr: result.stderr };
  },
});
