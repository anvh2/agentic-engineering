/**
 * Loads and cross-validates the engineering pack from `<root>/engineering/{skills,agents}/*.json`.
 *
 * Reads only that directory, only regular `.json` files whose name equals `<id>.json`, refuses symlinks and oversized files,
 * and never executes or imports anything it reads. A single invalid file fails the whole load: a half-loaded catalog would
 * make selection results depend on which files happened to parse.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashValue } from '../canonical.ts';
import { parseAgentManifest } from './agents.ts';
import { parseSkillManifest, skillDigest } from './skills.ts';
import type { AgentManifest, SkillManifest } from './schema.ts';

const MAX_FILE_BYTES = 64 * 1024;
const MAX_FILES = 128;

export interface PackRegistry {
  readonly skills: readonly SkillManifest[];
  readonly agents: readonly AgentManifest[];
  readonly skillById: ReadonlyMap<string, SkillManifest>;
  readonly agentById: ReadonlyMap<string, AgentManifest>;
  /** Digest over every manifest, for status display and drift detection. */
  readonly digest: string;
}

function readJsonDir(dir: string): { name: string; value: unknown }[] {
  let names: string[];
  try { names = readdirSync(dir).sort(); } catch { throw new Error(`pack: cannot read ${dir}`); }
  if (names.length > MAX_FILES) throw new Error(`pack: ${dir} holds more than ${MAX_FILES} files`);
  return names.map((name) => {
    if (!name.endsWith('.json')) throw new Error(`pack: unexpected file ${name} in ${dir}`);
    const path = join(dir, name);
    const info = lstatSync(path);
    if (!info.isFile()) throw new Error(`pack: ${name} is not a regular file`);
    if (info.size > MAX_FILE_BYTES) throw new Error(`pack: ${name} exceeds ${MAX_FILE_BYTES} bytes`);
    try { return { name, value: JSON.parse(readFileSync(path, 'utf8')) as unknown }; } catch { throw new Error(`pack: ${name} is not valid JSON`); }
  });
}

export function loadPackRegistry(root: string): PackRegistry {
  const skills = readJsonDir(join(root, 'engineering', 'skills')).map(({ name, value }) => {
    let manifest: SkillManifest;
    try { manifest = parseSkillManifest(value); } catch (e) { throw new Error(`pack: ${name}: ${(e as Error).message}`); }
    if (name !== `${manifest.id}.json`) throw new Error(`pack: skill file ${name} does not match its id ${manifest.id}`);
    return manifest;
  });
  const skillById = new Map(skills.map((s) => [s.id, s]));
  if (skillById.size !== skills.length) throw new Error('pack: duplicate skill id');
  for (const s of skills) for (const d of s.dependsOn) if (!skillById.has(d)) throw new Error(`pack: skill ${s.id} depends on unknown skill ${d}`);
  assertAcyclic(skills);
  const agents = readJsonDir(join(root, 'engineering', 'agents')).map(({ name, value }) => {
    let manifest: AgentManifest;
    try { manifest = parseAgentManifest(value, skillById); } catch (e) { throw new Error(`pack: ${name}: ${(e as Error).message}`); }
    if (name !== `${manifest.id}.json`) throw new Error(`pack: agent file ${name} does not match its id ${manifest.id}`);
    return manifest;
  });
  const agentById = new Map(agents.map((a) => [a.id, a]));
  if (agentById.size !== agents.length) throw new Error('pack: duplicate agent id');
  return Object.freeze({
    skills: Object.freeze(skills), agents: Object.freeze(agents), skillById, agentById,
    digest: hashValue({ skills: skills.map((s) => [s.id, skillDigest(s)]), agents: agents.map((a) => [a.id, hashValue(a)]) }),
  });
}

function assertAcyclic(skills: readonly SkillManifest[]): void {
  const byId = new Map(skills.map((s) => [s.id, s]));
  const done = new Set<string>(), stack = new Set<string>();
  const visit = (id: string): void => {
    if (stack.has(id)) throw new Error(`pack: skill dependency cycle through ${id}`);
    if (done.has(id)) return;
    stack.add(id);
    for (const d of byId.get(id)!.dependsOn) visit(d);
    stack.delete(id);
    done.add(id);
  };
  for (const s of skills) visit(s.id);
}
