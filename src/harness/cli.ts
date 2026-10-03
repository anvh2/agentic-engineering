import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existingReferences, missingReferences, notesTemplate, parseNotes } from './notes.ts';
import { renderResume, renderStatus } from './packet.ts';
import { HARNESS_ROOT, loadCheckpoint, loadProject, newCheckpointId, projectPaths, readOptional, writeCheckpoint } from './project.ts';
import { reconcile } from './reconcile.ts';
import { emptiedFiles, relateHeads, takeSnapshot } from './snapshot.ts';
import { describeTest, runTests } from './tests.ts';
import type { Checkpoint, Finding, RepoSnapshot, TestResult } from './types.ts';

/**
 * harness checkpoint|resume|status <project>
 *
 * Exit codes: 0 ok · 1 status found critical drift · 2 usage/validation
 * error · 3 repository identity mismatch (wrong repo; nothing produced).
 */

const CLI_PATH = fileURLToPath(import.meta.url);

const USAGE = `usage:
  harness checkpoint <project> --engine <name> --notes <file|-> [--no-test] [-- <test argv…>]
  harness checkpoint <project> --template
  harness resume <project> [--no-test] [--checkpoint <id>]
  harness status <project> [--test] [--checkpoint <id>]`;

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  readStdin: () => Promise<string>;
  harnessRoot?: string;
}

class UsageError extends Error {}
class IdentityError extends Error {}

interface Args {
  command: string;
  project: string;
  flags: Map<string, string | true>;
  testArgv: string[] | null;
}

const VALUE_FLAGS = new Set(['--engine', '--notes', '--checkpoint']);
const BOOL_FLAGS = new Set(['--no-test', '--test', '--template']);

function parseArgs(argv: string[]): Args {
  const dashdash = argv.indexOf('--');
  const head = dashdash >= 0 ? argv.slice(0, dashdash) : argv;
  const testArgv = dashdash >= 0 ? argv.slice(dashdash + 1) : null;
  const [command, project, ...rest] = head;
  if (!command || !project) throw new UsageError(USAGE);
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (VALUE_FLAGS.has(flag)) {
      const value = rest[++i];
      if (value === undefined) throw new UsageError(`${flag} requires a value.`);
      flags.set(flag, value);
    } else if (BOOL_FLAGS.has(flag)) flags.set(flag, true);
    else throw new UsageError(`Unknown argument "${flag}".\n${USAGE}`);
  }
  if (testArgv && testArgv.length === 0) throw new UsageError('"--" must be followed by a test command.');
  return { command, project, flags, testArgv };
}

async function snapshotChecked(name: string, harnessRoot: string) {
  const { config, repoPath } = await loadProject(name, harnessRoot);
  let now: RepoSnapshot;
  try {
    now = await takeSnapshot(repoPath, config.expectedLocal);
  } catch (err) {
    throw new UsageError(`Cannot read repository ${repoPath}: ${(err as Error).message}`);
  }
  if (now.rootCommit !== config.identity.rootCommit) {
    throw new IdentityError(
      `Repository identity mismatch at ${repoPath}: root commit ${now.rootCommit}, project.json expects ${config.identity.rootCommit}. Refusing to continue.`,
    );
  }
  return { config, repoPath, now };
}

async function checkpointCommand(args: Args, io: Io, harnessRoot: string): Promise<number> {
  if (args.flags.has('--template')) {
    io.out(notesTemplate());
    return 0;
  }
  const engine = args.flags.get('--engine');
  const notesSource = args.flags.get('--notes');
  if (typeof engine !== 'string' || typeof notesSource !== 'string') throw new UsageError(`checkpoint requires --engine and --notes.\n${USAGE}`);
  if (args.testArgv && args.flags.has('--no-test')) throw new UsageError('Use either --no-test or "-- <test argv>", not both.');

  // Validate notes before doing any expensive work.
  const markdown = notesSource === '-' ? await io.readStdin() : await readOptional(notesSource);
  if (markdown === null) throw new UsageError(`Notes file not found: ${notesSource}`);
  const parsed = parseNotes(markdown);
  if ('errors' in parsed) throw new UsageError(`Notes rejected; no checkpoint written:\n- ${parsed.errors.join('\n- ')}`);

  const { config, repoPath, now } = await snapshotChecked(args.project, harnessRoot);
  const test: TestResult | { skipped: true } = args.flags.has('--no-test')
    ? { skipped: true }
    : await runTests(args.testArgv ?? config.test.command, repoPath, config.test.timeoutMs);

  const checkpoint: Checkpoint = {
    schema: 'harness.checkpoint/1',
    id: newCheckpointId(),
    project: args.project,
    createdAt: new Date().toISOString(),
    engine,
    repo: now,
    test,
    emptiedAtCapture: emptiedFiles(now),
    notes: parsed.notes,
    referencedPaths: await existingReferences(repoPath, parsed.notes),
  };
  const path = await writeCheckpoint(projectPaths(args.project, harnessRoot).checkpointsDir, checkpoint);

  io.out(`Checkpoint ${checkpoint.id} written: ${path}\n`);
  io.out(`- HEAD ${now.head?.slice(0, 10)} on ${now.branch ?? '(detached)'}; ${now.entries.length} dirty entries\n`);
  io.out(`- tests: ${describeTest(test)}\n`);
  if (checkpoint.emptiedAtCapture.length) io.out(`- WARNING emptied files recorded: ${checkpoint.emptiedAtCapture.join(', ')}\n`);
  if (now.entriesTruncated) io.out('- WARNING worktree listing truncated\n');
  return 0;
}

async function reconcileCommand(args: Args, io: Io, harnessRoot: string, mode: 'resume' | 'status'): Promise<number> {
  const { config, repoPath, now } = await snapshotChecked(args.project, harnessRoot);
  const paths = projectPaths(args.project, harnessRoot);
  const checkpointId = args.flags.get('--checkpoint');
  const loaded = await loadCheckpoint(paths.checkpointsDir, typeof checkpointId === 'string' ? checkpointId : undefined);

  const runTest = mode === 'resume' ? !args.flags.has('--no-test') : args.flags.has('--test');
  const testCommand = loaded && !('skipped' in loaded.checkpoint.test) ? loaded.checkpoint.test.command : config.test.command;
  const test = runTest ? await runTests(testCommand, repoPath, config.test.timeoutMs) : null;

  let findings: Finding[];
  if (loaded) {
    findings = reconcile({
      checkpoint: loaded.checkpoint,
      now,
      heads: await relateHeads(repoPath, loaded.checkpoint.repo.head, now.head),
      missingReferences: await missingReferences(repoPath, loaded.checkpoint.referencedPaths),
      test,
    });
  } else {
    findings = emptiedFiles(now).map((p) => ({ severity: 'critical' as const, code: 'file-emptied', message: `${p} is 0 bytes but non-empty in HEAD.` }));
  }

  if (mode === 'status') {
    io.out(renderStatus(args.project, now, findings, loaded?.checkpoint ?? null, test));
    return findings.some((f) => f.severity === 'critical') ? 1 : 0;
  }
  if (!loaded) throw new UsageError(`No checkpoint for "${args.project}" yet. Run: harness checkpoint ${args.project} --engine <name> --notes <file|->`);
  io.out(
    renderResume({
      project: args.project,
      checkpoint: loaded.checkpoint,
      checkpointPath: loaded.path,
      findings,
      now,
      test,
      principles: await readOptional(join(paths.leadDir, 'principles.md')),
      state: await readOptional(join(paths.projectDir, 'STATE.md')),
      expectedLocal: config.expectedLocal,
      cliPath: CLI_PATH,
      harnessRoot,
    }),
  );
  return 0;
}

export async function main(argv: string[], io: Io): Promise<number> {
  const harnessRoot = io.harnessRoot ?? HARNESS_ROOT;
  try {
    const args = parseArgs(argv);
    switch (args.command) {
      case 'checkpoint':
        return await checkpointCommand(args, io, harnessRoot);
      case 'resume':
        return await reconcileCommand(args, io, harnessRoot, 'resume');
      case 'status':
        return await reconcileCommand(args, io, harnessRoot, 'status');
      default:
        throw new UsageError(`Unknown command "${args.command}".\n${USAGE}`);
    }
  } catch (err) {
    io.err(`harness: ${(err as Error).message}\n`);
    return err instanceof IdentityError ? 3 : 2;
  }
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] === CLI_PATH) {
  process.exitCode = await main(process.argv.slice(2), {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
    readStdin: readAllStdin,
  });
}
