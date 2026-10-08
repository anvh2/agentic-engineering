import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { EngineeringLead, EngineeringObjective, PlanDraft, PlannedTask } from '../types.ts';
import { scanRepository } from '../research.ts';

// Isolate fixture git from the user's global config (signing, hooks, etc.).
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'fixture';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'fixture@example.com';

export const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'demo-service', type: 'module', scripts: { test: 'jest' }, dependencies: { express: '^4.0.0' }, devDependencies: { jest: '^29.0.0' } }, null, 2),
  'src/server.js': "import { logger } from './middleware/logger.js';\n// HTTP API entrypoint: routes are mounted here\nexport function createServer(app) {\n  app.use(logger);\n  return app;\n}\n",
  'src/config.js': "export const config = { port: 3000, apiPrefix: '/api' };\n",
  'src/middleware/logger.js': 'export function logger(req, res, next) {\n  next();\n}\n',
  'src/middleware/logger.test.js': "import { logger } from './logger.js';\ntest('calls next', () => { let called = false; logger({}, {}, () => { called = true; }); expect(called).toBe(true); });\n",
  'src/auth/session.js': "// session tokens and password checks\nexport function verifySession(token) {\n  return token === 'ok';\n}\n",
  'src/ui/Widget.jsx': 'export const Widget = () => null;\n',
  'migrations/001_init.sql': 'CREATE TABLE users (id int);\n',
};

export interface Fixture {
  root: string;
  repo: string;
  workdir: string;
  git: (...args: string[]) => string;
  cleanup: () => Promise<void>;
}

export async function makeFixture(files: Record<string, string> = FILES): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'objective-'));
  const repo = join(root, 'repo');
  const workdir = join(root, 'workdir');
  await mkdir(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return { root, repo, workdir, git, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export function objectiveFor(fx: Fixture, over: Partial<EngineeringObjective> = {}): EngineeringObjective {
  return { id: 'rate-limit', title: 'Add API rate limiting', description: 'Add API rate limiting to this service so one client cannot exhaust it.', repository: fx.repo, constraints: [], acceptanceCriteria: [], ...over };
}

export const assessment = { complexity: 'small', risk: 'low', ambiguity: 'none', rationale: 'bounded, mechanically verified' } as const;

/** A LOCAL_WORKER task that satisfies the whole delegation policy; override fields to break it. */
export function worker(id: string, over: Partial<PlannedTask> = {}): PlannedTask {
  const file = `src/middleware/${id}.js`;
  const oracle = `src/middleware/${id}.hidden.test.js`;
  return {
    id,
    title: `Implement ${id}`,
    description: `Implement ${id}.`,
    dependsOn: [],
    executionOwner: 'LOCAL_WORKER',
    allowedFiles: [file],
    contextFiles: [],
    acceptanceCriteria: [`${id} behaves as specified`],
    verificationCommands: [['npx', '--no-install', 'jest', '--runInBand', oracle]],
    constraints: ['Tests are immutable: do not change any test file'],
    hiddenFiles: { [oracle]: `test('${id}', () => {});\n` },
    assessment,
    ...over,
  };
}

export function lead(id: string, over: Partial<PlannedTask> = {}): PlannedTask {
  return {
    id,
    title: `Lead ${id}`,
    description: `Lead-owned ${id}.`,
    dependsOn: [],
    executionOwner: 'CLAUDE_LEAD',
    allowedFiles: ['src/server.js'],
    contextFiles: [],
    acceptanceCriteria: [`${id} is wired and reviewed`],
    verificationCommands: [],
    constraints: [],
    hiddenFiles: {},
    assessment: { complexity: 'medium', risk: 'medium', ambiguity: 'some', rationale: 'touches the shared entrypoint' },
    ...over,
  };
}

export function draftOf(tasks: PlannedTask[], over: Partial<PlanDraft> = {}): PlanDraft {
  return { summary: 'Add rate limiting as middleware and wire it in.', findings: [], risks: [], integrationCommands: [], linkPaths: [], tasks, ...over };
}

/** A scripted EngineeringLead: real read-only research, a canned (untrusted) draft. */
export function scriptedLead(draft: unknown | (() => Promise<unknown> | unknown), hooks: { beforeResearch?: () => Promise<void> | void; beforePlan?: () => Promise<void> | void } = {}): EngineeringLead {
  return {
    name: 'scripted',
    async research(objective) {
      await hooks.beforeResearch?.();
      return scanRepository(objective);
    },
    async plan() {
      await hooks.beforePlan?.();
      return typeof draft === 'function' ? (draft as () => unknown)() : draft;
    },
  };
}
