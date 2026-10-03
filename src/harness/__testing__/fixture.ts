import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cli.ts';

/**
 * Throwaway layout mirroring the real one:
 *   <parent>/harness/lead/projects/demo/project.json   (repo: "../repo")
 *   <parent>/repo/                                     (git repo under test)
 *   <parent>/tools/fake-test.mjs + testout.json        (controllable test command)
 */

// Isolate fixture git from the user's global config (signing, hooks, etc.).
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'fixture';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'fixture@example.com';

export const VALID_NOTES = `# Session notes
## Goal
Add the widget module.
## Changed
Created src/widget.js.
## Why
The lead asked for it.
## Attempts
none
## Discoveries
src/app.js already exports a registry.
## Open questions
none
## Blockers
none
## Next
Write tests for src/widget.js.
`;

const FAKE_TEST = `import { readFileSync } from 'node:fs';
const spec = JSON.parse(readFileSync(new URL('./testout.json', import.meta.url), 'utf8'));
if (spec.sleepMs) await new Promise((r) => setTimeout(r, spec.sleepMs));
process.stderr.write(spec.out);
process.exit(spec.exit);
`;

export function jestOutput(failing: string[], passing: string[], failedTests = failing.length): string {
  const lines = [...failing.map((s) => `FAIL ${s}`), ...passing.map((s) => `PASS ${s}`)];
  const total = failing.length + passing.length;
  lines.push(
    `Test Suites: ${failing.length ? `${failing.length} failed, ` : ''}${passing.length} passed, ${total} total`,
    `Tests:       ${failedTests ? `${failedTests} failed, ` : ''}10 passed, ${10 + failedTests} total`,
  );
  return `${lines.join('\n')}\n`;
}

export interface Fixture {
  parent: string;
  harnessRoot: string;
  repo: string;
  git: (...args: string[]) => string;
  write: (rel: string, content: string) => Promise<void>;
  setTest: (spec: { exit: number; out: string; sleepMs?: number }) => Promise<void>;
  setProject: (patch: Record<string, unknown>) => Promise<void>;
  cli: (argv: string[], stdin?: string) => Promise<{ code: number; out: string; err: string }>;
  cleanup: () => Promise<void>;
}

export async function createFixture(): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), 'harness-v0a-'));
  const harnessRoot = join(parent, 'harness');
  const repo = join(parent, 'repo');
  const tools = join(parent, 'tools');
  await mkdir(join(harnessRoot, 'lead', 'projects', 'demo'), { recursive: true });
  await mkdir(join(repo, 'src'), { recursive: true });
  await mkdir(join(repo, 'config'), { recursive: true });
  await mkdir(tools, { recursive: true });

  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  const write = (rel: string, content: string) => writeFile(join(repo, rel), content);

  git('init', '-q', '-b', 'main');
  await write('src/app.js', 'export const registry = {};\n');
  await write('src/empty.js', '');
  await write('config/default.json', '{"db":"prod"}\n');
  git('add', '.');
  git('commit', '-q', '-m', 'initial');
  const rootCommit = git('rev-list', '--max-parents=0', 'HEAD').trim();

  await writeFile(join(tools, 'fake-test.mjs'), FAKE_TEST);
  const setTest = (spec: { exit: number; out: string; sleepMs?: number }) => writeFile(join(tools, 'testout.json'), JSON.stringify(spec));
  await setTest({ exit: 0, out: jestOutput([], ['src/app.test.js']) });

  let project: Record<string, unknown> = {
    schema: 'harness.project/1',
    repo: '../repo',
    identity: { rootCommit },
    test: { command: ['node', join(tools, 'fake-test.mjs')], timeoutMs: 10_000 },
    expectedLocal: ['config/default.json', 'docs/'],
  };
  const setProject = async (patch: Record<string, unknown>) => {
    project = { ...project, ...patch };
    await writeFile(join(harnessRoot, 'lead', 'projects', 'demo', 'project.json'), JSON.stringify(project, null, 2));
  };
  await setProject({});
  await writeFile(join(harnessRoot, 'lead', 'principles.md'), '- Repository evidence wins.\n');
  await writeFile(join(harnessRoot, 'lead', 'projects', 'demo', 'STATE.md'), '# demo\nGoal: ship widgets.\n');

  const cli = async (argv: string[], stdin = '') => {
    let out = '';
    let err = '';
    const code = await main(argv, {
      out: (t) => (out += t),
      err: (t) => (err += t),
      readStdin: async () => stdin,
      harnessRoot,
    });
    return { code, out, err };
  };

  return { parent, harnessRoot, repo, git, write, setTest, setProject, cli, cleanup: () => rm(parent, { recursive: true, force: true }) };
}

/** Takes a checkpoint with VALID_NOTES and asserts success. */
export async function checkpoint(f: Fixture, extra: string[] = []): Promise<string> {
  const result = await f.cli(['checkpoint', 'demo', '--engine', 'engine-a', '--notes', '-', ...extra], VALID_NOTES);
  if (result.code !== 0) throw new Error(`checkpoint failed: ${result.err}`);
  return result.out;
}
