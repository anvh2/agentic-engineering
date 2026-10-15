/**
 * Operator CLI for the engineering pack (wrapper: scripts/engineering.ts).
 *
 *   status [--json] [--probe-ollama]   pack, skills, agents, drift, health, provider readiness, issues
 *   agents [--json] | skills [--json]  catalogue listings
 *   validate                           exit 1 unless the pack loads and every declared scenario passes
 *   drift [--strict]                   promoted-vs-manifest drift; --strict exits 1 on any stale or orphaned skill
 *   pin --language go|js|ts --type <task-type> --text "..."   print the `knowledge` pin for a task contract (read-only)
 *   render claude-code <agent-id>      print a Claude Code subagent definition to stdout (writes and installs nothing)
 *   promote|revoke <skill-id> --grant <file>   apply a PRE-SIGNED grant from a trusted promoter key
 *
 * Read-only by default. This CLI contains no signing command on purpose: a tool that signs grants next to the agents it would
 * authorize is a self-promotion path. Keys belong to the operator, outside anything an agent can read.
 * Options: --root <dir> (pack root, default project root), --db <file>, --keyring <file>.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { findProjectRoot } from '../../core/paths.ts';
import { buildEngineeringReport, probeOllama, providerReadiness, readActiveKnowledge, type EngineeringReport } from './engineering-control.ts';
import { DurableEngineeringKnowledge, keyringPromotionAuthority, type PromotionGrant } from './engineering-knowledge-store.ts';
import { loadPackRegistry, type PackRegistry } from './packs/loader.ts';
import { renderClaudeCodeAgent } from './packs/agents.ts';
import { activeSkillDigests, pinSkillsForTask, promotedDigestOf, renderSkill, skillToCandidate } from './packs/skills.ts';
import { EngineeringKnowledgeCatalog } from './engineering-knowledge.ts';
import { TASK_TYPES, type TaskType } from './packs/schema.ts';
import { TrustedKeyring, type SignedStatement, type TrustedKeyInput } from './trust.ts';

export interface CliIo { out(text: string): void; err(text: string): void }

const flagValue = (args: readonly string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function render(report: EngineeringReport): string {
  const lines = [
    `engineering pack: ${report.pack.loaded ? `loaded (${report.pack.skills} skills, ${report.pack.agents} agents, digest ${report.pack.digest!.slice(0, 12)})` : `NOT LOADED: ${report.pack.error}`}`,
    ...(report.scenarios ? [`scenarios: ${report.scenarios.passed}/${report.scenarios.total} pass`] : []),
    `skills: ${report.skills.filter((s) => s.state === 'active').length} active, ${report.drift.unpromoted.length} not promoted, ${report.drift.stale.length} stale, ${report.drift.orphaned.length} orphaned`,
    'providers:', ...report.providers.map((p) => `  ${p.id}: ${p.configured ? 'configured' : 'not configured'} [${p.basis}] ${p.detail}`),
    `issues (${report.issues.length}):`, ...report.issues.map((i) => `  ${i.level.toUpperCase()} ${i.code}: ${i.detail}`),
    `report digest: ${report.reportDigest.slice(0, 16)}`,
  ];
  return lines.join('\n');
}

function openRegistry(root: string): { registry?: PackRegistry; error?: string } {
  try { return { registry: loadPackRegistry(root) }; } catch (e) { return { error: (e as Error).message }; }
}

export async function runEngineeringCli(argv: readonly string[], io: CliIo, env: NodeJS.ProcessEnv = process.env, now: () => number = Date.now): Promise<number> {
  const [command, ...rest] = argv;
  const json = argv.includes('--json');
  const root = resolve(flagValue(argv, '--root') ?? findProjectRoot() ?? process.cwd());
  const dbPath = resolve(flagValue(argv, '--db') ?? join(root, '.workdir', 'engineering', 'knowledge.db'));
  const keyringPath = resolve(flagValue(argv, '--keyring') ?? join(root, '.workdir', 'engineering', 'keyring.json'));
  const positional = rest.filter((a, i) => !a.startsWith('--') && !(rest[i - 1] ?? '').startsWith('--'));
  const emit = (value: unknown, text: () => string) => io.out(json ? JSON.stringify(value, null, 2) : text());

  try {
    const { registry, error } = openRegistry(root);
    const active = readActiveKnowledge(dbPath);
    switch (command) {
      case 'status': {
        const providers = argv.includes('--probe-ollama') ? [await probeOllama(env), ...providerReadiness(env).filter((p) => p.id !== 'ollama')] : undefined;
        const report = buildEngineeringReport({ registry, registryError: error, activeEntries: active, env, now: now(), providers });
        emit(report, () => render(report));
        return report.issues.some((i) => i.level === 'error') ? 1 : 0;
      }
      case 'agents': {
        const report = buildEngineeringReport({ registry, registryError: error, activeEntries: active, env, now: now() });
        emit(report.agents, () => report.agents.map((a) => `${a.id}@${a.version}  tools=${a.tools.join(',')}  skills ${a.skillsActive}/${a.skillPool} active  mastra+ollama: ${a.mastraOllama}`).join('\n'));
        return registry ? 0 : 1;
      }
      case 'skills': {
        const report = buildEngineeringReport({ registry, registryError: error, activeEntries: active, env, now: now() });
        emit(report.skills, () => report.skills.map((s) => `${s.id}@${s.version}  [${s.category}]  ${s.state}  ${s.bytes}B`).join('\n'));
        return registry ? 0 : 1;
      }
      case 'validate': {
        const report = buildEngineeringReport({ registry, registryError: error, activeEntries: [], env, now: now() });
        const failed = !registry || (report.scenarios?.failures.length ?? 0) > 0;
        emit({ ok: !failed, pack: report.pack, scenarios: report.scenarios }, () => failed ? `INVALID: ${error ?? report.scenarios!.failures.map((f) => `${f.skill}/${f.scenario}`).join(', ')}` : `ok: ${report.pack.skills} skills, ${report.pack.agents} agents, ${report.scenarios!.total} scenarios pass`);
        return failed ? 1 : 0;
      }
      case 'drift': {
        const report = buildEngineeringReport({ registry, registryError: error, activeEntries: active, env, now: now() });
        emit(report.drift, () => `stale: ${report.drift.stale.join(', ') || '-'}\norphaned: ${report.drift.orphaned.join(', ') || '-'}\nnot promoted: ${report.drift.unpromoted.length}`);
        return argv.includes('--strict') && (report.drift.stale.length || report.drift.orphaned.length) ? 1 : 0;
      }
      case 'pin': {
        const language = flagValue(argv, '--language'), type = flagValue(argv, '--type'), text = flagValue(argv, '--text');
        if (!registry) { io.err(`pack not loaded: ${error}`); return 1; }
        if (!language || !['go', 'js', 'ts'].includes(language) || !type || !(TASK_TYPES as readonly string[]).includes(type) || !text) {
          io.err('usage: pin --language go|js|ts --type <task-type> --text "<task text>"'); return 2;
        }
        const global = active.filter((e) => e.projectId === undefined);
        const catalog = new EngineeringKnowledgeCatalog(global);
        const pin = pinSkillsForTask(registry.skills, catalog, { language: language as 'go' | 'js' | 'ts', taskType: type as TaskType, text });
        emit({ knowledge: pin.knowledge ?? null, selected: pin.selection.selected, omitted: pin.selection.omitted }, () => pin.knowledge
          ? `knowledge: ${JSON.stringify(pin.knowledge)}\nselected: ${pin.selection.selected.join(', ')}`
          : `no skills selected (${pin.selection.omitted.length} considered and omitted)`);
        return 0;
      }
      case 'render': {
        const [target, agentId] = positional;
        if (target !== 'claude-code' || !agentId) { io.err('usage: render claude-code <agent-id>'); return 2; }
        const manifest = registry?.agentById.get(agentId);
        if (!registry || !manifest) { io.err(`unknown agent ${agentId}${error ? `: ${error}` : ''}`); return 1; }
        const activeMap = activeSkillDigests(active);
        const skills = [...manifest.skills, ...manifest.optionalSkills].map((id) => registry.skillById.get(id)!).filter((s) => activeMap.get(s.id) === promotedDigestOf(s));
        const rendered = renderClaudeCodeAgent(manifest, skills, (s) => renderSkill(s));
        if (rendered.unsupportedTools.length) io.err(`note: tools not expressible in Claude Code without shell access were omitted: ${rendered.unsupportedTools.join(', ')}`);
        io.out(rendered.markdown);
        return 0;
      }
      case 'promote':
      case 'revoke': {
        const [skillId] = positional;
        const grantFile = flagValue(argv, '--grant');
        if (!skillId || !grantFile) { io.err(`usage: ${command} <skill-id> --grant <signed-grant.json>`); return 2; }
        if (!existsSync(keyringPath)) { io.err(`no trusted keyring at ${keyringPath}; provision operator public keys first`); return 1; }
        const keyring = new TrustedKeyring(JSON.parse(readFileSync(keyringPath, 'utf8')) as TrustedKeyInput[]);
        const grant = JSON.parse(readFileSync(resolve(grantFile), 'utf8')) as SignedStatement<PromotionGrant>;
        mkdirSync(dirname(dbPath), { recursive: true });
        const store = new DurableEngineeringKnowledge(new DatabaseSync(dbPath));
        const authority = keyringPromotionAuthority(keyring);
        const current = store.activeCatalog().list().find((e) => e.id === skillId);
        if (command === 'revoke') {
          store.revoke(skillId, grant, authority);
          emit({ ok: true, action: 'revoked', skillId }, () => `revoked ${skillId}`);
          return 0;
        }
        const manifest = registry?.skillById.get(skillId);
        if (!manifest) { io.err(`unknown skill ${skillId}`); return 1; }
        const candidate = skillToCandidate(manifest);
        if (current && current.revision === candidate.revision) { emit({ ok: true, action: 'unchanged', skillId }, () => `${skillId} is already active at ${candidate.revision}`); return 0; }
        if (current) store.supersede(candidate, current.revision, grant, authority); else store.promote(candidate, grant, authority);
        emit({ ok: true, action: current ? 'superseded' : 'promoted', skillId, revision: candidate.revision }, () => `${current ? 'superseded' : 'promoted'} ${skillId} -> ${candidate.revision}`);
        return 0;
      }
      default:
        io.err('usage: engineering status|agents|skills|validate|drift|pin|render|promote|revoke [--json] [--root dir] [--db file] [--keyring file]');
        return 2;
    }
  } catch (e) {
    io.err(`error: ${(e as Error).message}`);
    return 1;
  }
}
