import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../session/run.ts';
import { buildPlanPrompt, buildRevisionPrompt, extractJsonObject, readExcerpts } from './lead-prompt.ts';
import { scanRepository } from './research.ts';
import type { EngineeringLead, EngineeringObjective, ResearchContext } from './types.ts';
import type { PlanIssue } from './validate.ts';

/**
 * A model-backed Engineering Lead behind the existing EngineeringLead boundary.
 *
 *   Claude proposes:  the model sees a bounded prompt (objective, ResearchContext, file excerpts) and returns JSON text.
 *   The runtime disposes: that text is an untrusted draft that goes through the same deterministic validation as a
 *   human-written one, and only an explicit `--submit` ever queues it.
 *
 * The model is given no tools and no working directory inside the target repository, so it cannot mutate the repository,
 * read beyond the prompt or touch scheduler state; the only channel back is text. Research stays the deterministic,
 * read-only scan, so the plan's evidence does not depend on model behavior.
 */

export interface LeadTransport {
  /** One prompt in, the model's text reply out. Must not give the model tools or repository access. */
  complete(prompt: string, options: { timeoutMs: number }): Promise<string>;
}

export interface ClaudeLeadOptions {
  timeoutMs?: number;
  /** Test seam: replaces the excerpt reader. */
  excerpts?: typeof readExcerpts;
}

export class ClaudeEngineeringLead implements EngineeringLead {
  readonly name = 'claude';
  private readonly transport: LeadTransport;
  private readonly timeoutMs: number;
  private readonly readExcerpts: typeof readExcerpts;

  constructor(transport: LeadTransport, options: ClaudeLeadOptions = {}) {
    this.transport = transport;
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
    this.readExcerpts = options.excerpts ?? readExcerpts;
  }

  research(objective: EngineeringObjective): Promise<ResearchContext> {
    return scanRepository(objective);
  }

  async plan(objective: EngineeringObjective, research: ResearchContext): Promise<unknown> {
    const excerpts = await this.readExcerpts(research.repository, research);
    return extractJsonObject(await this.transport.complete(buildPlanPrompt(objective, research, excerpts), { timeoutMs: this.timeoutMs }));
  }

  async revise(objective: EngineeringObjective, research: ResearchContext, previous: unknown, issues: PlanIssue[]): Promise<unknown> {
    const excerpts = await this.readExcerpts(research.repository, research);
    return extractJsonObject(await this.transport.complete(buildRevisionPrompt(objective, research, excerpts, previous, issues), { timeoutMs: this.timeoutMs }));
  }
}

/**
 * Transport over the `claude` CLI in print mode: all tools disabled, no session persistence, run from an empty scratch
 * directory. NOTE: this makes a real (billed) Claude call and has only been exercised against a stand-in executable;
 * nothing in the runtime invokes it unless the user selects it explicitly.
 */
export function claudeCliTransport(options: { command?: string; model?: string; extraArgs?: string[] } = {}): LeadTransport {
  return {
    async complete(prompt, { timeoutMs }) {
      const scratch = await mkdtemp(join(tmpdir(), 'lead-claude-'));
      try {
        // the prompt goes first: `--tools` is variadic and would swallow a positional that follows it
        const args = ['-p', prompt, '--tools', '', '--no-session-persistence', '--output-format', 'text', ...(options.model ? ['--model', options.model] : []), ...(options.extraArgs ?? [])];
        const result = await run(options.command ?? 'claude', args, { cwd: scratch, timeoutMs, maxBytes: 4 * 1024 * 1024 });
        if (result.startError) throw new Error(`could not start ${options.command ?? 'claude'}: ${result.startError}`);
        if (result.timedOut) throw new Error(`the Lead model timed out after ${timeoutMs} ms`);
        if (result.exitCode !== 0) throw new Error(`the Lead model exited ${result.exitCode}: ${result.stderr.trim().slice(0, 300)}`);
        return result.stdout;
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
  };
}
