import { relative } from 'node:path';
import { verdict } from './reconcile.ts';
import { describeTest } from './tests.ts';
import { NOTE_SECTIONS, type Checkpoint, type Finding, type RepoSnapshot, type TestResult } from './types.ts';

/**
 * Renders the compact, engine-neutral handoff text. Plain markdown on
 * stdout: any coding engine can consume it. Content from principles.md and
 * STATE.md is included verbatim and never truncated - if the packet runs
 * over budget, a warning says so and the lead decides what to cut.
 */

export const TOKEN_BUDGET = 2_000;
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

const ORDER: Record<Finding['severity'], number> = { critical: 0, warn: 1, info: 2 };

function age(createdAt: string, now: Date): string {
  const minutes = Math.round((now.getTime() - new Date(createdAt).getTime()) / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

export function renderRepoNow(now: RepoSnapshot, test: TestResult | null, checkpoint: Checkpoint | null): string {
  const other = now.entries.filter((e) => !e.expected).map((e) => `${e.code.trim()} ${e.path}`);
  const expected = now.entries.filter((e) => e.expected).map((e) => e.path);
  const lines = [
    `- branch: ${now.branch ?? '(detached)'} · HEAD ${now.head?.slice(0, 10) ?? 'none'} "${now.headSubject ?? ''}"`,
    `- dirty (task): ${other.length ? other.slice(0, 30).join(', ') + (other.length > 30 ? ` … +${other.length - 30} more` : '') : 'none'}`,
    `- dirty (intentional local, do not commit/revert): ${expected.length ? expected.join(', ') : 'none'}`,
    `- diff vs HEAD: ${now.diffStat.files} files, +${now.diffStat.insertions}/-${now.diffStat.deletions}`,
  ];
  if (checkpoint) {
    const cmd = 'skipped' in checkpoint.test ? '' : ` (\`${checkpoint.test.command.join(' ')}\`)`;
    lines.push(`- tests now: ${test ? describeTest(test) : 'NOT re-verified'} · recorded: ${describeTest(checkpoint.test)}${cmd}`);
  } else if (test) {
    lines.push(`- tests now: ${describeTest(test)} (\`${test.command.join(' ')}\`)`);
  }
  return lines.join('\n');
}

export function renderFindings(findings: Finding[]): string {
  const sorted = [...findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  return sorted.map((f) => `- ${f.severity.toUpperCase()} [${f.code}] ${f.message}`).join('\n');
}

export interface PacketInput {
  project: string;
  checkpoint: Checkpoint;
  checkpointPath: string;
  findings: Finding[];
  now: RepoSnapshot;
  test: TestResult | null;
  principles: string | null;
  state: string | null;
  expectedLocal: string[];
  cliPath: string;
  harnessRoot: string;
  date?: Date;
}

export function renderResume(p: PacketInput): string {
  const c = p.checkpoint;
  const notes = NOTE_SECTIONS.map(([key, title]) => `**${title}:** ${c.notes[key]}`).join('\n');
  const rel = (path: string) => relative(p.harnessRoot, path);
  const inspect = [
    `- checkpoint record: ${p.checkpointPath}`,
    `- work since checkpoint: \`git log --oneline ${c.repo.head?.slice(0, 10)}..HEAD\`, \`git diff ${c.repo.head?.slice(0, 10)}\``,
    '- a specific file: `git diff -- <path>` (diffs are never stored in checkpoints)',
  ];
  if (!('skipped' in c.test)) inspect.push(`- recorded test output tail: \`test.tail\` in the checkpoint record`);

  const sections = [
    `# RESUME ${p.project} — checkpoint ${c.id} (by ${c.engine}, ${age(c.createdAt, p.date ?? new Date())})`,
    `Repository: ${p.now.path}`,
    `## Verdict: ${verdict(p.findings)}`,
    p.findings.length ? `## Reconciliation — repository evidence wins over everything below\n${renderFindings(p.findings)}` : '',
    `## Repository now\n${renderRepoNow(p.now, p.test, c)}`,
    `## Principles (${rel(`${p.harnessRoot}/docs/operations/lead-principles.md`)})\n${p.principles?.trim() ?? '(missing)'}`,
    `## Project state (lead-owned WHY; projects/${p.project}/STATE.md)\n${p.state?.trim() ?? '(missing)'}`,
    `## Last session — engine claims; verify against the sections above\n${notes}`,
    `## Inspect if needed\n${inspect.join('\n')}`,
    [
      '## Session rules',
      `- Do not commit, revert or modify: ${p.expectedLocal.join(', ') || '(none)'}`,
      '- Where this packet and the repository disagree, trust the repository and say so.',
      `- Before ending, checkpoint: \`node ${p.cliPath} checkpoint ${p.project} --engine <your-name> --notes - <<'EOF'\` … \`EOF\` (template: \`node ${p.cliPath} checkpoint ${p.project} --template\`). Keep notes out of the repository.`,
    ].join('\n'),
  ];
  const text = sections.filter(Boolean).join('\n\n');
  const tokens = estimateTokens(text);
  const footer =
    tokens > TOKEN_BUDGET
      ? `\n\n> WARNING: packet is ~${tokens} tokens (budget ${TOKEN_BUDGET}). Nothing was truncated; the lead should shorten STATE.md/principles.md or the notes.`
      : '';
  return `${text}${footer}\n`;
}

export function renderStatus(project: string, now: RepoSnapshot, findings: Finding[], checkpoint: Checkpoint | null, test: TestResult | null): string {
  const head = checkpoint ? `# STATUS ${project} — vs checkpoint ${checkpoint.id} (by ${checkpoint.engine})` : `# STATUS ${project} — no checkpoint yet`;
  const parts = [head, `Repository: ${now.path}`];
  if (checkpoint) parts.push(`## Verdict: ${verdict(findings)}`);
  if (findings.length) parts.push(`## Findings\n${renderFindings(findings)}`);
  parts.push(`## Repository now\n${renderRepoNow(now, test, checkpoint)}`);
  return `${parts.join('\n\n')}\n`;
}
