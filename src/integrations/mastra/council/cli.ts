import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Mastra } from '@mastra/core/mastra';
import { findProjectRoot } from '../../../core/paths.ts';
import type { CouncilRecord } from '../../../runtime/council/record.ts';
import { registerSpecialists } from '../specialist-agents.ts';
import { engineeringCouncilWorkflow, type CouncilWorkflowInput, type CouncilWorkflowResult } from './council-workflow.ts';
import { councilReadiness, renderReadiness } from './readiness.ts';
import { councilRegistration } from './register.ts';
import { runCouncilOnServer } from './server-client.ts';

/**
 * `npm run council -- status | run | show`. Thin on purpose: it parses flags and prints. The council itself is the workflow.
 *
 *   status [--probe] [--json]        readiness of the pack, the Mastra registration, the panel and both modes (no model call)
 *   run [--live] [--meeting-id ID] [--question TEXT] [--in-process] [--server URL] [--json]
 *                                    default SCRIPTED (offline). --live needs AGENTIC_COUNCIL_LIVE=1. Runs on the Mastra server
 *                                    (so traces appear in Studio) unless --in-process.
 *   show ID [--json]                 print a stored record
 *
 * Exit codes: 0 decided, 1 closed without a decision, 2 refused (nothing ran), 3 server unreachable, 130 suspended.
 */
export interface CliIo { out: (l: string) => void; err: (l: string) => void }

const flag = (argv: string[], name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const has = (argv: string[], name: string) => argv.includes(name);

export function summarize(r: CouncilRecord, runId?: string, studio?: string): string[] {
  const phases = r.rounds.map((x) => `${x.round} ${x.phase}`).join(' -> ');
  const obj = r.critiques.filter((c) => c.stance === 'object').length;
  const sup = r.critiques.length - obj;
  const decision = (r.synthesis?.synthesis as { decision?: string } | undefined)?.decision;
  const lines = [
    `Council ${r.meetingId} [${r.mode}] -> ${r.outcome} (${r.reason})`,
    `Panel: ${r.panel.map((p) => `${p.specialistId}${p.chair ? ' (chair)' : ''}`).join(', ')} on ${r.panel[0]!.provider}/${r.panel[0]!.model}`,
    `Rounds: ${phases}; proposals ${r.proposals.length}, critiques ${r.critiques.length} (${obj} objection, ${sup} support)`,
    `Disagreement: ${r.disagreements.raised ? `raised, ${r.disagreements.objections.filter((o) => o.status === 'outstanding').length} objection(s) outstanding` : 'none raised (none invented)'}`,
    `Proposed decision: ${decision ?? '(none recorded)'}`,
    `Human approval: ${r.humanApproval.status.toUpperCase()} (nothing was adopted)`,
    `Accounting: ${r.accounting.modelCalls} model call(s), ${r.accounting.reasks} re-ask(s), ${r.accounting.invalidReplies} invalid, tokens in ${r.accounting.tokens.input} / out ${r.accounting.tokens.output}; turns ${r.accounting.turnsReserved}/${r.accounting.limits.maxInvocations}`,
  ];
  if (r.mode === 'SCRIPTED') lines.push('SCRIPTED: canned replies. This proves wiring and rules, not model quality.');
  if (runId) lines.push(`Mastra workflow run: ${runId}${studio ? `\nStudio: ${studio}` : ''}`);
  return lines;
}

export async function runCouncilCli(argv: string[], io: CliIo): Promise<number> {
  const [cmd, ...rest] = argv;
  const root = findProjectRoot();
  if (!root) { io.err('council: project root not found'); return 2; }
  const workdir = join(root, '.workdir');
  const json = has(rest, '--json');

  if (cmd === 'status') {
    const specialists = registerSpecialists();
    const readiness = await councilReadiness({ specialists, probe: has(rest, '--probe') });
    io.out(json ? JSON.stringify(readiness, null, 2) : renderReadiness(readiness));
    return readiness.scripted.ready ? 0 : 2;
  }

  if (cmd === 'show') {
    const id = rest.find((a) => !a.startsWith('--'));
    const file = id ? join(workdir, 'council', id, json ? 'record.json' : 'record.md') : '';
    if (!id || !existsSync(file)) { io.err(`council: no record for ${id ?? '<meeting-id>'} under ${join(workdir, 'council')}`); return 2; }
    io.out(readFileSync(file, 'utf8'));
    return 0;
  }

  if (cmd === 'run') {
    const live = has(rest, '--live');
    const input: CouncilWorkflowInput = { mode: live ? 'live' : 'scripted', ...(flag(rest, '--meeting-id') ? { meetingId: flag(rest, '--meeting-id') } : {}), ...(flag(rest, '--question') ? { question: flag(rest, '--question') } : {}) };
    io.err(`council: ${live ? 'LIVE (local Ollama)' : 'SCRIPTED (offline, no model)'} run${has(rest, '--in-process') ? ', in this process (no Studio trace)' : ''}`);
    let result: CouncilWorkflowResult | undefined;
    let runId: string | undefined;
    let studio: string | undefined;
    if (has(rest, '--in-process')) {
      const specialists = registerSpecialists();
      const council = councilRegistration(specialists);
      const mastra = new Mastra({ agents: { ...specialists.agents, ...council.agents }, workflows: { engineeringCouncilWorkflow } });
      const r = (await (await mastra.getWorkflow('engineeringCouncilWorkflow').createRun()).start({ inputData: input as never })) as { status: string; result?: CouncilWorkflowResult; error?: unknown };
      if (r.status !== 'success' || !r.result) { io.err(`council: workflow ended ${r.status}: ${JSON.stringify(r.error ?? '').slice(0, 500)}`); return 1; }
      result = r.result;
      runId = result.workflowRunId;
    } else {
      const r = await runCouncilOnServer(input, { server: flag(rest, '--server'), onProgress: (l) => io.err(`council: ${l}`) });
      runId = r.runId;
      studio = r.studioUrl;
      if (!r.result) { io.err(`council: ${r.error}`); if (r.unreachable) io.err('council: or run without a server: npm run council -- run --in-process'); return r.unreachable ? 3 : 1; }
      result = r.result;
    }
    if (result.status === 'refused') {
      io.err(`council: REFUSED, nothing ran and no model was called:\n  - ${result.reasons.join('\n  - ')}`);
      return 2;
    }
    if (result.status === 'suspended' || result.status === 'superseded') {
      io.err(`council: meeting ${result.meetingId} is ${result.status} and open. Resume it: npm run council -- run --meeting-id ${result.meetingId}${live ? ' --live' : ''}`);
      return 130;
    }
    const file = join(workdir, 'council', result.meetingId, 'record.json');
    if (!existsSync(file)) { io.err(`council: the run reported a record at ${file} but it does not exist on this machine`); return 1; }
    const record = JSON.parse(readFileSync(file, 'utf8')) as CouncilRecord;
    if (json) io.out(JSON.stringify({ result, record }, null, 2));
    else { io.out(summarize(record, runId, studio).join('\n')); io.out(`Record: ${join(workdir, 'council', result.meetingId, 'record.md')}`); }
    return record.outcome === 'decided' ? 0 : 1;
  }

  io.err('usage: npm run council -- status [--probe] [--json] | run [--live] [--meeting-id ID] [--question TEXT] [--in-process] [--server URL] [--json] | show ID [--json]');
  return 2;
}
