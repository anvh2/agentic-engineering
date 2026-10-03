import { z } from 'zod';
import { runClaudeCli } from './claude-cli.ts';
import type { CodingDelegation } from '../workflows/coding-task-workflow.ts';

const REVIEWER_SYSTEM_PROMPT = `You are a senior engineer doing a post-hoc code review. You have no tools and cannot read or modify the repository yourself - you are given everything you need as text: the original task, the delegation given to the worker, the worker's own final response, the actual git diff of what changed on disk, and the objective test/format results.

The worker's own final response is commentary, not evidence - it can be wrong, incomplete, or overstate what happened. The git diff and test/format results are what actually happened; weigh them over the worker's prose whenever they disagree.

Review for: (1) does the diff satisfy the stated task, (2) does it follow the conventions visible in the diff/repository context, (3) any obvious correctness problems, (4) are the tests (if any) sufficient for the change, (5) did the worker touch files unrelated to the task, (6) did the worker actually verify its own work (format + test) rather than merely claiming to. Be specific and concrete - cite the actual diff content, not generalities.`;

const reviewOutputSchema = z
  .object({
    satisfiesTask: z.boolean().describe('Does the actual diff satisfy the original task and requirements?'),
    followsConventions: z.boolean().describe('Does the change follow the conventions visible in the repository/diff?'),
    correctnessConcerns: z.array(z.string()).describe('Concrete correctness problems found, if any. Empty array if none.'),
    testsSufficient: z.boolean().describe('Are the tests (existing or added) sufficient to cover the change?'),
    modifiedUnrelatedFiles: z.boolean().describe('Did the diff touch files unrelated to the stated task?'),
    workerVerifiedItsOwnWork: z
      .boolean()
      .describe('Based on the test/format results provided (not the worker\'s prose), did the worker actually verify its change?'),
    summary: z.string().describe('A short, concrete summary of the review.'),
    verdict: z.enum(['approve', 'approve_with_concerns', 'reject']),
  })
  .required();

export type CodingReview = z.infer<typeof reviewOutputSchema>;

export interface ReviewInput {
  task: string;
  delegation: CodingDelegation;
  workerFinalResponse: string;
  gitDiff: string;
  gitDiffStat: string;
  testResult: unknown;
  gofmtCompleted: boolean;
  goTestPassed: boolean;
  patchApplied: boolean;
  /** Optional: the repository's own Trellis spec content (.trellis/spec/), if any, so "followsConventions" is judged against real project guidelines, not just what's inferable from the diff alone. */
  trellisSpecExcerpt?: string;
}

function buildReviewPrompt(input: ReviewInput): string {
  const sections = [
    `## Original task\n${input.task}`,
    `## Delegation given to the worker\n${JSON.stringify(input.delegation, null, 2)}`,
    `## Worker's own final response (commentary only - NOT authoritative)\n${input.workerFinalResponse || '(empty)'}`,
    `## Objective, tool-confirmed state (authoritative)\npatchApplied: ${input.patchApplied}\ngofmtCompleted: ${input.gofmtCompleted}\ngoTestPassed: ${input.goTestPassed}`,
    `## Actual git diff --stat (authoritative - what really changed on disk)\n${input.gitDiffStat || '(empty)'}`,
    `## Actual git diff (authoritative)\n${input.gitDiff || '(empty diff - nothing changed on disk)'}`,
    `## Last go test result (authoritative)\n${JSON.stringify(input.testResult, null, 2)}`,
  ];
  if (input.trellisSpecExcerpt) {
    sections.push(
      `## This repository's own coding guidelines (Trellis spec, .trellis/spec/) - judge "followsConventions" against these, not just general Go style\n${input.trellisSpecExcerpt}`,
    );
  }
  return sections.join('\n\n');
}

/**
 * Invokes the local Claude Code CLI, with no tools at all (`--tools ''`
 * inside runClaudeCli), to review a completed coding-worker run. This is
 * read-only by construction - the reviewer physically cannot touch the
 * repository, since the CLI process it runs in has no tool access.
 */
export async function reviewCodingResult(input: ReviewInput): Promise<CodingReview> {
  const { $schema: _unused, ...jsonSchema } = z.toJSONSchema(reviewOutputSchema);

  const parsed = await runClaudeCli({
    prompt: buildReviewPrompt(input),
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
    jsonSchema,
  });

  if (parsed.is_error || parsed.structured_output === undefined) {
    throw new Error(`Claude reviewer failed to produce a review: ${parsed.result ?? 'unknown error'}`);
  }

  return reviewOutputSchema.parse(parsed.structured_output);
}
