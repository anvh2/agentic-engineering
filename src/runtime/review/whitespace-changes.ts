/**
 * Classifies the lines of a change that differ ONLY in whitespace, from two zero-context diffs of the same file:
 * the raw one and the `-w` one (which hides whitespace-only differences).
 *
 * "Unrelated formatting" is what the review gate wants to stop; code that moved into or out of a block and was re-indented
 * with it (gofmt/prettier do that automatically) is part of the change itself. The line-level rules:
 *
 *  - a whitespace-only line whose text is unchanged apart from its indentation is a RE-INDENT; a run of re-indents with one
 *    uniform indentation shift is a block move. It is harmless when it sits next to a real (non-whitespace) change.
 *  - any other whitespace-only line (internal spacing, trailing spaces, line endings, a different shift) is NOISE.
 *    A few noise lines next to a real change are tolerated and reported; more than that, or noise far from any real change,
 *    is unrelated formatting.
 *  - re-indentation far from every real change is unrelated formatting, and so is a file whose only change is whitespace.
 *
 * Nothing here looks at what the code does: semantic review, scope checks and the verifier stay with their own gates.
 */

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  removed: string[];
  added: string[];
}

export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  for (const line of diff.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      current = { oldStart: Number(header[1]), oldCount: header[2] === undefined ? 1 : Number(header[2]), newStart: Number(header[3]), newCount: header[4] === undefined ? 1 : Number(header[4]), removed: [], added: [] };
      hunks.push(current);
    } else if (current && line.startsWith('-') && !line.startsWith('---')) current.removed.push(line.slice(1));
    else if (current && line.startsWith('+') && !line.startsWith('+++')) current.added.push(line.slice(1));
  }
  return hunks;
}

const indentOf = (s: string) => /^[ \t]*/.exec(s)![0].length;
const stripIndent = (s: string) => s.replace(/^[ \t]+/, '');

export interface WhitespaceClassification {
  /** Lines (new-file numbers) that differ only in whitespace. */
  whitespaceOnly: number;
  /** Pure block re-indents next to a real change: harmless, reported as a warning. */
  attachedReindent: number;
  /** Stray spacing edits next to a real change, within the tolerance. */
  attachedNoise: number;
  /** Whitespace-only lines that are unrelated formatting (the blockers), with the first few line numbers. */
  unrelated: { count: number; lines: number[]; reason: string }[];
  /** True when the file has no real (non-whitespace) change at all. */
  noSemanticChange: boolean;
}

export interface WhitespaceOptions {
  /** How near (in lines) a whitespace run must be to a real change to count as part of it. */
  proximity?: number;
  /** Stray spacing edits tolerated next to a real change. */
  attachedNoiseLimit?: number;
}

const squash = (s: string) => s.replace(/\s+/g, '');

export function classifyWhitespaceChanges(rawDiff: string, semanticDiff: string, options: WhitespaceOptions = {}): WhitespaceClassification {
  const proximity = options.proximity ?? 3;
  const noiseLimit = options.attachedNoiseLimit ?? 3;
  const rawHunks = parseHunks(rawDiff);
  const semHunks = parseHunks(semanticDiff);

  // The lines the `-w` diff still reports are the real changes. They are compared by TEXT (whitespace squashed), never by line
  // number: `diff` and `diff -w` may align the same edit differently (an added closing brace, say).
  const bag = (texts: string[]) => {
    const m = new Map<string, number>();
    for (const t of texts) m.set(squash(t), (m.get(squash(t)) ?? 0) + 1);
    return m;
  };
  const semAdded = bag(semHunks.flatMap((h) => h.added));
  const semRemoved = bag(semHunks.flatMap((h) => h.removed));
  const take = (m: Map<string, number>, text: string): boolean => {
    const n = m.get(squash(text)) ?? 0;
    if (n > 0) m.set(squash(text), n - 1);
    return n > 0;
  };

  interface Line {
    n: number;
    reindentDelta: number | undefined;
  }
  const lines: Line[] = [];
  const semPositions: number[] = [];
  for (const h of rawHunks) {
    // 1. a removed and an added line with the same text apart from indentation are a re-indent pair
    const removed = h.removed.map((text) => ({ text, stripped: stripIndent(text), used: false }));
    const paired = new Map<number, number | undefined>(); // added index -> indentation delta
    h.added.forEach((text, i) => {
      const stripped = stripIndent(text);
      const partner = stripped === '' ? undefined : removed.find((r) => !r.used && r.stripped === stripped && indentOf(r.text) !== indentOf(text));
      if (partner) {
        partner.used = true;
        paired.set(i, indentOf(text) - indentOf(partner.text));
      }
    });
    // 2. whatever is left is a real change if `-w` still reports it, otherwise it is a whitespace edit that is not a re-indent
    h.added.forEach((text, i) => {
      const n = h.newStart + i;
      if (paired.has(i)) lines.push({ n, reindentDelta: paired.get(i) });
      else if (take(semAdded, text)) semPositions.push(n);
      else lines.push({ n, reindentDelta: undefined });
    });
    // a real deletion happens at the hunk's position (between newStart and newStart+1 when nothing was added)
    for (const r of removed) if (!r.used && take(semRemoved, r.text)) semPositions.push(h.newStart, ...(h.newCount === 0 ? [h.newStart + 1] : []));
  }
  lines.sort((a, b) => a.n - b.n);

  // runs of nearby whitespace-only lines (an unchanged blank line inside a re-indented block must not split it)
  const runs: Line[][] = [];
  for (const line of lines) {
    const run = runs.at(-1);
    if (run && line.n - run.at(-1)!.n <= 2) run.push(line);
    else runs.push([line]);
  }

  const result: WhitespaceClassification = { whitespaceOnly: lines.length, attachedReindent: 0, attachedNoise: 0, unrelated: [], noSemanticChange: semHunks.length === 0 && rawHunks.length > 0 };
  for (const run of runs) {
    const attached = semPositions.some((p) => run.some((l) => Math.abs(l.n - p) <= proximity));
    const deltas = new Set(run.map((l) => l.reindentDelta));
    const pureReindent = !deltas.has(undefined) && deltas.size === 1;
    const lineNumbers = run.map((l) => l.n);
    if (pureReindent) {
      if (attached) result.attachedReindent += run.length;
      else result.unrelated.push({ count: run.length, lines: lineNumbers, reason: 'a block was re-indented away from any real change' });
    } else if (attached && result.attachedNoise + run.length <= noiseLimit) {
      result.attachedNoise += run.length;
    } else {
      result.unrelated.push({ count: run.length, lines: lineNumbers, reason: attached ? 'more reformatting than a real change accounts for (mixed or non-uniform whitespace edits)' : 'whitespace-only edits away from any real change' });
    }
  }
  return result;
}
