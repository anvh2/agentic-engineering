import { readFile } from 'node:fs/promises';
import { scanRepository } from './research.ts';
import type { EngineeringLead, EngineeringObjective, ResearchContext } from './types.ts';

/**
 * The Lead that exists today. There is no unattended Claude invocation in this runtime (see docs/architecture/runtime.md,
 * "Review"), so planning is a two-step hand-off rather than a pretend model call:
 *
 *   1. `lead objective <file>` runs the deterministic read-only research and writes research.json.
 *   2. The Engineering Lead (Claude in a session, or a human) reads it and writes draft.json (a PlanDraft).
 *   3. `lead objective <file>` again validates the draft and writes plan.json.
 *
 * A Claude-API-backed lead is just another EngineeringLead: same two methods, same untrusted-draft contract.
 */

export class DraftMissingError extends Error {
  readonly draftPath: string;
  constructor(draftPath: string) {
    super(`no plan draft at ${draftPath}`);
    this.name = 'DraftMissingError';
    this.draftPath = draftPath;
  }
}

export class DraftFileLead implements EngineeringLead {
  readonly name = 'draft-file';
  private readonly draftPath: string;

  constructor(draftPath: string) {
    this.draftPath = draftPath;
  }

  research(objective: EngineeringObjective): Promise<ResearchContext> {
    return scanRepository(objective);
  }

  async plan(): Promise<unknown> {
    let raw: string;
    try {
      raw = await readFile(this.draftPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new DraftMissingError(this.draftPath);
      throw err;
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(`plan draft ${this.draftPath} is not valid JSON: ${(err as Error).message}`);
    }
  }
}
