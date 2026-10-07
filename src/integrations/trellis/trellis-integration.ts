import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * Optional integration with a target repository's own Trellis setup
 * (`.trellis/`, if present - this project's own
 * checkout does not have one; some target repositories do). Trellis fills
 * the "context/task management" role in this pipeline:
 *
 *  - context: `.trellis/spec/**\/*.md` holds real, human-written project
 *    coding guidelines. Claude (the supervisor) has ample context budget to
 *    read all of it and fold task-relevant conventions into the delegation
 *    it writes - the Ollama worker's prompt and tool surface never change,
 *    it just receives a better-grounded delegation.
 *  - task management: `.trellis/tasks/` via `task.py create`/`start`/
 *    `finish` gives this automated run a real, cross-session-visible task
 *    record, the same mechanism a human using Trellis would get.
 *
 * Everything here is best-effort and silently no-ops when the target
 * repository has no Trellis setup (`.trellis/scripts/task.py` missing) - it
 * must never turn "no Trellis here" into a pipeline failure. `task.py
 * archive` (the one Trellis command that can auto-commit) is deliberately
 * never called here - only `create`/`start`/`finish`, none of which touch
 * git (confirmed by reading task.py: only `archive` has commit logic, and
 * even that has an explicit --no-commit flag).
 */

const MAX_SPEC_BYTES = 200_000;

function runPython(args: string[], cwd: string, timeoutMs = 15_000): Promise<{ success: boolean; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn('python3', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolvePromise({ success: false, stdout: '', stderr: (err as Error).message });
      return;
    }

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ success: false, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ success: code === 0, stdout, stderr });
    });
  });
}

/** True if the target repository has a Trellis setup this integration can use. */
export async function hasTrellis(repositoryRoot: string): Promise<boolean> {
  return stat(join(repositoryRoot, '.trellis', 'scripts', 'task.py')).then(
    () => true,
    () => false,
  );
}

export interface TrellisSpecContext {
  files: string[];
  text: string;
  truncated: boolean;
}

/**
 * Reads every Markdown file under `.trellis/spec/` and concatenates them
 * with path headers, for the Claude supervisor (not the Ollama worker) to
 * digest - this is plain file reading, not a Trellis script call, since the
 * spec system is just Markdown files Trellis's own tooling also reads
 * directly.
 */
export async function readTrellisSpecContext(repositoryRoot: string): Promise<TrellisSpecContext | undefined> {
  const specRoot = join(repositoryRoot, '.trellis', 'spec');
  const hasSpec = await stat(specRoot).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!hasSpec) return undefined;

  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(full);
      }
    }
  }
  await walk(specRoot);
  files.sort();

  let text = '';
  let truncated = false;
  const relFiles: string[] = [];
  for (const file of files) {
    if (Buffer.byteLength(text, 'utf8') >= MAX_SPEC_BYTES) {
      truncated = true;
      break;
    }
    const relPath = relative(repositoryRoot, file);
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    relFiles.push(relPath);
    text += `\n\n## ${relPath}\n\n${content}`;
  }

  return { files: relFiles, text: text.trim(), truncated };
}

export interface TrellisTaskHandle {
  slug: string;
  taskDir: string | undefined;
  started: boolean;
}

/**
 * Best-effort: creates and starts a Trellis task for this automated run.
 * Never throws - a failure here (e.g. no session identity available for
 * `task.py start` outside an interactive Trellis-aware session) just means
 * this run isn't tracked in `.trellis/tasks/`, which is not fatal to the
 * actual coding work.
 */
export async function createAndStartTrellisTask(
  repositoryRoot: string,
  title: string,
  slug: string,
): Promise<TrellisTaskHandle> {
  const createResult = await runPython(
    ['.trellis/scripts/task.py', 'create', title, '--slug', slug],
    repositoryRoot,
  );
  if (!createResult.success) {
    return { slug, taskDir: undefined, started: false };
  }

  const startResult = await runPython(['.trellis/scripts/task.py', 'start', slug], repositoryRoot);

  return { slug, taskDir: `.trellis/tasks/*-${slug}`, started: startResult.success };
}

/** Best-effort: clears the active-task pointer. Never throws. */
export async function finishTrellisTask(repositoryRoot: string): Promise<void> {
  await runPython(['.trellis/scripts/task.py', 'finish'], repositoryRoot);
}
