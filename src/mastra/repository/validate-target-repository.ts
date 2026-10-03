import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Pre-flight check for TARGET_REPOSITORY, run once before any agent or
 * workflow touches the repository. The path always comes from the caller
 * (the environment) - nothing here lets the model choose or override it.
 */
export interface RepositoryValidationResult {
  valid: boolean;
  resolvedPath: string | undefined;
  errors: string[];
  gitStatus?: string;
}

function runGitStatus(cwd: string): Promise<{ success: boolean; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn('git', ['status', '--short'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolvePromise({ success: false, stdout: '', stderr: (err as Error).message });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
    child.on('error', (err) => resolvePromise({ success: false, stdout, stderr: err.message }));
    child.on('close', (code) => resolvePromise({ success: code === 0, stdout, stderr }));
  });
}

export async function validateTargetRepository(repositoryPath: string | undefined): Promise<RepositoryValidationResult> {
  if (!repositoryPath || repositoryPath.trim() === '') {
    return { valid: false, resolvedPath: undefined, errors: ['TARGET_REPOSITORY is not set.'] };
  }

  const resolvedPath = resolve(repositoryPath);
  const errors: string[] = [];

  let pathStat;
  try {
    pathStat = await stat(resolvedPath);
  } catch {
    return { valid: false, resolvedPath, errors: [`TARGET_REPOSITORY does not exist: "${resolvedPath}".`] };
  }

  if (!pathStat.isDirectory()) {
    return { valid: false, resolvedPath, errors: [`TARGET_REPOSITORY is not a directory: "${resolvedPath}".`] };
  }

  const gitDirExists = await stat(resolve(resolvedPath, '.git')).then(
    () => true,
    () => false,
  );
  if (!gitDirExists) {
    errors.push(`TARGET_REPOSITORY does not look like a git repository (no ".git" found at "${resolvedPath}").`);
  }

  const statusResult = await runGitStatus(resolvedPath);
  if (!statusResult.success) {
    errors.push(`"git status" failed in TARGET_REPOSITORY: ${statusResult.stderr.trim() || 'unknown error'}`);
    return { valid: false, resolvedPath, errors };
  }

  return { valid: errors.length === 0, resolvedPath, errors, gitStatus: statusResult.stdout };
}
