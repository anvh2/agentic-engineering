import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import type { ProjectIssueRow, SchedulerStore } from '../../runtime/scheduler/store.ts';
import { resolveTargetRepository, type TargetRepository } from '../../runtime/project/target-repository.ts';

/**
 * `lead project add|list|show|sync-issues`: binds a stable project id (e.g. `cloudfarm`) to exactly one target repository,
 * and mirrors that project's GitHub issues read-only for display and linking. GitHub stays the source of truth for task
 * tracking: nothing here creates, edits or closes an issue, and objectives link issues by number instead of copying them.
 */

export interface ProjectCliDeps {
  store: SchedulerStore;
  cwd: string;
  out(text: string): void;
  err(text: string): void;
  /** Runs `gh` with argv and returns stdout (injected in tests). Default: the real `gh` CLI, read-only `issue list`. */
  gh?: (args: string[]) => Promise<string>;
}

/** `owner/name` of a GitHub remote (https or ssh), or null. */
export function githubRepoOf(origin: string | null): string | null {
  const m = origin?.match(/github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

const defaultGh = (args: string[]) =>
  new Promise<string>((ok, fail) =>
    execFile('gh', args, { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => (err ? fail(new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${(stderr || err.message).trim().slice(0, 300)}`)) : ok(stdout))),
  );

/** Parses `gh issue list --json number,title,state,url,labels,milestone,updatedAt`. Malformed entries are refused, never repaired. */
export function parseGhIssues(text: string): Omit<ProjectIssueRow, 'projectId' | 'syncedAt'>[] {
  const raw = JSON.parse(text) as unknown;
  if (!Array.isArray(raw)) throw new Error('gh returned something other than a JSON array');
  return raw.map((i: any) => {
    if (!Number.isInteger(i?.number) || typeof i?.title !== 'string' || typeof i?.state !== 'string' || typeof i?.url !== 'string') throw new Error('gh returned a malformed issue');
    return {
      number: i.number,
      title: i.title,
      state: i.state,
      url: i.url,
      labels: Array.isArray(i.labels) ? i.labels.map((l: any) => String(l?.name ?? '')).filter(Boolean) : [],
      milestone: typeof i.milestone?.title === 'string' ? i.milestone.title : null,
      updatedAt: typeof i.updatedAt === 'string' ? i.updatedAt : null,
    };
  });
}

const describe = (t: TargetRepository) => `${t.repositoryId}  root=${t.canonicalRoot}  git=${t.gitCommonDir}  worktrees=${t.worktreeRoot}${t.isFramework ? '  (FRAMEWORK repository: self-hosting)' : ''}`;

export async function runProjectCommand(args: string[], deps: ProjectCliDeps): Promise<number> {
  const [sub, id] = args;
  const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const { store } = deps;
  try {
    if (sub === 'add') {
      const repo = flag('--repo');
      if (!id || !repo) throw new Error('usage: project add <project-id> --repo <path> [--github owner/name]');
      const target = resolveTargetRepository(resolve(deps.cwd, repo));
      const githubRepo = flag('--github') ?? githubRepoOf(target.origin);
      const row = store.registerProject({ projectId: id, target, githubRepo });
      deps.out(`project ${row.projectId}: ${describe(row.target)}${row.githubRepo ? `  github=${row.githubRepo}` : ''}`);
      return 0;
    }
    if (sub === 'list') {
      for (const p of store.listProjects()) deps.out(`${p.projectId}  ${describe(p.target)}${p.githubRepo ? `  github=${p.githubRepo}` : ''}`);
      return 0;
    }
    if (sub === 'show') {
      const p = id ? store.getProject(id) : undefined;
      if (!p) throw new Error(`project ${id ?? '(none)'} is not registered`);
      deps.out(JSON.stringify({ ...p, issues: store.projectIssues(p.projectId), batches: store.listBatches().filter((b) => b.project === p.projectId).map((b) => ({ id: b.id, issues: store.batchIssues(b.id), target: b.target?.repositoryId ?? null })) }, null, 2));
      return 0;
    }
    if (sub === 'sync-issues') {
      const p = id ? store.getProject(id) : undefined;
      if (!p) throw new Error(`project ${id ?? '(none)'} is not registered`);
      if (!p.githubRepo) throw new Error(`project ${p.projectId} has no GitHub repository; register it with --github owner/name`);
      const text = await (deps.gh ?? defaultGh)(['issue', 'list', '--repo', p.githubRepo, '--state', 'all', '--limit', '500', '--json', 'number,title,state,url,labels,milestone,updatedAt']);
      const n = store.syncProjectIssues(p.projectId, parseGhIssues(text));
      deps.out(`synchronized ${n} issue(s) of ${p.githubRepo} for project ${p.projectId} (read-only; GitHub remains the source of truth)`);
      return 0;
    }
    deps.err('usage: project add <id> --repo <path> [--github owner/name] | list | show <id> | sync-issues <id>');
    return 2;
  } catch (err) {
    deps.err(`project: ${(err as Error).message}`);
    return 1;
  }
}
