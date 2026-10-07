import { stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { NOTE_SECTIONS, type EngineNotes, type NoteKey } from './types.ts';

/**
 * Engine-supplied session notes: a markdown document with a fixed set of
 * "## " headings. This is the only engine-authored part of a checkpoint;
 * everything git or tests can determine is collected by the CLI instead.
 */

export const MAX_SECTION_CHARS = 1_500;
const REQUIRED: NoteKey[] = ['goal', 'next'];
const MAX_REFERENCES = 50;

export function notesTemplate(): string {
  const hints: Record<NoteKey, string> = {
    goal: 'The current task goal, in one or two sentences.',
    changed: 'What changed this session (facts the repo will confirm).',
    why: 'Why it changed - the reasoning the diff cannot show.',
    attempts: 'Approaches tried and how they failed, or "none".',
    discoveries: 'Non-obvious facts learned about the code or environment, or "none".',
    questions: 'Unresolved questions for the lead, or "none".',
    blockers: 'What prevents progress, or "none".',
    next: 'The exact next step the receiving engine should take.',
  };
  return NOTE_SECTIONS.map(([key, title]) => `## ${title}\n${hints[key]}\n`).join('\n');
}

export function parseNotes(markdown: string): { notes: EngineNotes } | { errors: string[] } {
  const byTitle = new Map(NOTE_SECTIONS.map(([key, title]) => [title.toLowerCase(), key]));
  const found = new Map<NoteKey, string[]>();
  const errors: string[] = [];
  let current: string[] | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      const key = byTitle.get(heading[1].toLowerCase());
      if (!key) {
        errors.push(`Unknown section "## ${heading[1]}". Allowed: ${NOTE_SECTIONS.map(([, t]) => t).join(', ')}.`);
        current = null;
      } else if (found.has(key)) {
        errors.push(`Duplicate section "## ${heading[1]}".`);
        current = null;
      } else {
        current = [];
        found.set(key, current);
      }
      continue;
    }
    current?.push(line);
  }

  const notes = {} as EngineNotes;
  for (const [key, title] of NOTE_SECTIONS) {
    const body = found.get(key);
    if (!body) {
      errors.push(`Missing section "## ${title}".`);
      continue;
    }
    const text = body.join('\n').trim();
    if (REQUIRED.includes(key) && (text === '' || text.toLowerCase() === 'none')) {
      errors.push(`Section "## ${title}" must not be empty.`);
    }
    if (text.length > MAX_SECTION_CHARS) {
      errors.push(`Section "## ${title}" is ${text.length} chars; limit is ${MAX_SECTION_CHARS}. Summarize and point to evidence instead.`);
    }
    notes[key] = text === '' ? 'none' : text;
  }
  return errors.length ? { errors } : { notes };
}

/** Path-like tokens: anything with a "/" or a file extension, stripped of markdown/punctuation. */
export function pathCandidates(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split(/[\s`*"'<>]+/)) {
    const token = raw.replace(/^[([{]+/, '').replace(/[)\]},;:.!?]+$/, '');
    if (!token || token.includes('://') || token.startsWith('-')) continue;
    if (token.includes('/') || /\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(token)) out.add(token.replace(/:\d+(-\d+)?$/, ''));
  }
  return [...out];
}

/**
 * Keeps only candidates that exist inside the repo at capture time, so a
 * later "referenced file is missing" finding means it really disappeared -
 * not that the regex matched prose like "pass/fail".
 */
export async function existingReferences(repoRoot: string, notes: EngineNotes): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of pathCandidates(Object.values(notes).join('\n'))) {
    const rel = isAbsolute(candidate) ? relative(repoRoot, candidate) : candidate.replace(/^\.\//, '');
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
    if (await stat(join(repoRoot, rel)).then(() => true, () => false)) found.push(rel);
    if (found.length >= MAX_REFERENCES) break;
  }
  return found;
}

export async function missingReferences(repoRoot: string, paths: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const p of paths) if (!(await stat(join(repoRoot, p)).then(() => true, () => false))) missing.push(p);
  return missing;
}
