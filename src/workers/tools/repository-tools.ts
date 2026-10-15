import { createTool } from '@mastra/core/tools';
import { randomUUID } from 'node:crypto';
import {
  readdir,
  readFile as readFileFromDisk,
  realpath,
  rename,
  rm,
  stat,
  writeFile as writeFileToDisk,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { applyPatch as applyUnifiedDiff, createPatch, parsePatch } from 'diff';
import { z } from 'zod';

/**
 * Key used to pass the repository root through Mastra's RequestContext.
 * Set by the workflow step before calling codingWorker; read by every
 * repository tool. Never trust a path supplied by the model itself.
 */
export const REPOSITORY_ROOT_CONTEXT_KEY = 'repository-root';

// The local Ollama models this project targets run with small context
// windows (often 4096 tokens). Tool results are appended straight into that
// context, so they're kept deliberately small - a generous readFile cap
// reliably overflows the context and Ollama drops the connection mid-request
// (surfaces as a socket error, and can leave the model answering from a
// half-lost conversation instead of what it actually read).
const MAX_READ_FILE_BYTES = 3_000;
const MAX_SCAN_FILE_BYTES = 300_000; // searchFiles only returns matching lines, so this can stay generous
const MAX_SEARCH_MATCHES = 20;
const MAX_SEARCH_FILES = 2000;
const MAX_MATCH_LINE_LENGTH = 200;
const MAX_LIST_ENTRIES = 300;
const SKIPPED_DIRECTORIES = new Set(['.git', 'vendor', 'node_modules', '.archived', 'dist', 'build', 'coverage']);
// Generous enough for adding a full table-driven test file in one call,
// tight enough that one model response can't silently rewrite most of a
// repository through a single tool call.
const MAX_PATCH_BYTES = 20_000;
const MAX_CHANGED_LINES = 200;

export function getRepositoryRoot(requestContext: { get(key: string): unknown } | undefined): string {
  const root = requestContext?.get(REPOSITORY_ROOT_CONTEXT_KEY);
  if (typeof root !== 'string' || root.trim() === '') {
    throw new Error('No repository is configured for this run.');
  }
  return resolve(root);
}

/** True if two absolute paths are the same location, or `child` is nested under `parent`. */
function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolves `path` to its real, symlink-free location, tolerating path
 * segments that don't exist yet. Node's `fs.realpath` requires the full
 * path to exist, which readFile/listFiles/searchFiles can't guarantee up
 * front (e.g. a nonexistent file, or a boundary check that must run before
 * we know whether the target exists at all). We walk up to the longest
 * existing ancestor, resolve *that* through any symlinks, then reattach the
 * remaining segments literally - a path that doesn't exist yet cannot be a
 * symlink, so nothing is lost by not resolving it.
 *
 * Exported so resolveWritablePathWithinRepository can reuse it for the
 * stricter, write-specific symlink check instead of duplicating this walk.
 */
export async function realpathTolerant(path: string): Promise<string> {
  let current = path;
  const trailingSegments: string[] = [];

  while (true) {
    try {
      const real = await realpath(current);
      return trailingSegments.length > 0 ? join(real, ...trailingSegments.reverse()) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;

      const parent = dirname(current);
      if (parent === current) return path; // hit the filesystem root; give up gracefully
      trailingSegments.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Resolves a model-supplied path against the repository root and rejects
 * anything that escapes it - via "../", an absolute path outside the root,
 * a sibling directory that merely shares the root's name as a string
 * prefix, or a symlink (anywhere in the path, including nested ones) whose
 * real target lands outside the root.
 *
 * The cheap string-based check runs first and rejects the common cases
 * without touching the filesystem; the symlink-aware `realpath` check runs
 * second and is authoritative, since string/path normalization alone
 * cannot see through symlinks.
 *
 * Exported so the boundary check itself can be unit tested directly,
 * independent of the filesystem-touching tools built on top of it.
 */
export async function resolveWithinRepository(root: string, requestedPath: string | undefined): Promise<string> {
  const candidate = resolve(root, requestedPath && requestedPath.trim() !== '' ? requestedPath : '.');

  if (!isWithin(root, candidate)) {
    throw new Error(`Path "${requestedPath}" is outside the repository root and cannot be accessed.`);
  }

  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = await realpathTolerant(root);
    realCandidate = await realpathTolerant(candidate);
  } catch {
    // Never surface the underlying filesystem error (it can include
    // absolute host paths) - the caller only needs to know resolution failed.
    throw new Error(`Unable to resolve path "${requestedPath ?? '.'}".`);
  }

  if (!isWithin(realRoot, realCandidate)) {
    throw new Error(`Path "${requestedPath}" is outside the repository root and cannot be accessed.`);
  }

  // Return the original (non-realpath'd) candidate, not the resolved one:
  // callers use it for display paths via relative(root, ...), and root
  // itself may sit behind a symlink (e.g. macOS's /tmp -> /private/tmp)
  // that would otherwise make legitimate paths look like they don't share
  // a prefix with `root`. The realpath check above already proved this
  // path's true target is inside the repository; subsequent fs calls
  // resolve symlinks themselves when they actually touch disk.
  return candidate;
}

/**
 * Stricter variant of resolveWithinRepository for anything that writes to
 * disk. Reads only need the *destination* to be inside the repository -
 * resolveWithinRepository's realpath check is sufficient there, and a
 * symlink swapped between check and read merely leaks a read. A write is
 * destructive, so the same TOCTOU window is a real risk: this additionally
 * requires the *path used to reach the target* to be direct, with no
 * symlink anywhere between the repository root and the target - including
 * an internal symlink whose real target is itself inside the repository.
 * (Escapes to outside the repository are already rejected by
 * resolveWithinRepository above; this only adds the stricter "no symlinks
 * at all" rule on top, so there remains exactly one authoritative boundary
 * check plus this one deliberate, documented tightening for writes.)
 */
export async function resolveWritablePathWithinRepository(
  root: string,
  requestedPath: string | undefined,
): Promise<string> {
  const target = await resolveWithinRepository(root, requestedPath);

  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await realpathTolerant(root);
    realTarget = await realpathTolerant(target);
  } catch {
    throw new Error(`Unable to resolve path "${requestedPath ?? '.'}".`);
  }

  const literalRel = relative(root, target);
  const realRel = relative(realRoot, realTarget);
  if (isProtectedPath(literalRel) || isProtectedPath(realRel)) {
    throw new Error(`Path "${requestedPath}" is protected (git metadata, installed dependencies or runtime temp files) and cannot be modified.`);
  }
  if (literalRel !== realRel) {
    throw new Error(
      `Path "${requestedPath}" cannot be modified because it is reached through a symlink. Writes must use a direct repository path.`,
    );
  }

  return target;
}

/**
 * Paths the runtime's mutation snapshot deliberately skips (coding-task-runner `snapshotRepo`), so a write there would be
 * invisible to the forbidden-mutation check and to the restore: `.git` (a directory, or a worktree's `.git` pointer file
 * whose rewrite redirects every later runtime git command to another repository), `node_modules` (the JS verifier runs
 * code from it) and the atomic-write temp prefix. Compared case-insensitively: the default macOS filesystem is.
 */
function isProtectedPath(repoRelative: string): boolean {
  const segments = repoRelative.split(/[\\/]/).map((s) => s.toLowerCase());
  return segments.some((s) => s === '.git' || s === 'node_modules') || (segments.at(-1) ?? '').startsWith('.applypatch-');
}

/**
 * Files that hold credentials. Tools that READ the repository refuse them, so a secret can never enter model context, a trace
 * or a report through a tool call (audit F-13). Matching is on the basename and on directory segments, case-insensitively, and
 * is applied to both the literal path and its symlink-resolved path. `.env.example` style templates stay readable.
 */
const SECRET_DIRECTORIES = new Set(['.ssh', '.aws', '.gnupg', '.kube']);
const SECRET_BASENAMES = new Set(['.npmrc', '.netrc', '.pypirc', '.git-credentials', 'credentials', 'credentials.json', 'secrets.json', 'secrets.yaml', 'secrets.yml', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519']);
const SECRET_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore'];
const TEMPLATE_SUFFIXES = ['.example', '.sample', '.template', '.dist'];
export function isSecretPath(repoRelative: string): boolean {
  const segments = repoRelative.split(/[\\/]/).filter(Boolean).map((s) => s.toLowerCase());
  if (segments.some((s) => SECRET_DIRECTORIES.has(s))) return true;
  const base = segments.at(-1) ?? '';
  if (SECRET_BASENAMES.has(base) || SECRET_EXTENSIONS.some((ext) => base.endsWith(ext))) return true;
  return (base === '.env' || base.startsWith('.env.')) && !TEMPLATE_SUFFIXES.some((suffix) => base.endsWith(suffix));
}

async function assertReadable(root: string, target: string, displayPath: string | undefined): Promise<void> {
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await realpathTolerant(root);
    realTarget = await realpathTolerant(target);
  } catch {
    throw new Error(`Unable to resolve path "${displayPath ?? '.'}".`);
  }
  if (isSecretPath(relative(root, target)) || isSecretPath(relative(realRoot, realTarget))) {
    throw new Error(`Path "${displayPath}" holds credentials and cannot be read by agent tools.`);
  }
}

async function statOrThrow(path: string, displayPath: string) {
  try {
    return await stat(path);
  } catch {
    throw new Error(`No such file or directory: "${displayPath}"`);
  }
}

export const listFiles = createTool({
  id: 'listFiles',
  description: 'List files/directories at a path (relative to repo root; use "." for root).',
  inputSchema: z.object({
    path: z.string().describe('Relative to repo root; "." for root.'),
  }),
  outputSchema: z.object({
    path: z.string(),
    entries: z.array(
      z.object({
        name: z.string(),
        type: z.enum(['file', 'directory', 'symlink', 'other']),
      }),
    ),
    truncated: z.boolean(),
  }),
  execute: async ({ path }, { requestContext }) => {
    const root = getRepositoryRoot(requestContext);
    const target = await resolveWithinRepository(root, path);
    const targetStat = await statOrThrow(target, path);

    if (!targetStat.isDirectory()) {
      return { path, entries: [{ name: relative(root, target) || '.', type: 'file' as const }], truncated: false };
    }

    let dirents;
    try {
      dirents = await readdir(target, { withFileTypes: true });
    } catch {
      throw new Error(`Unable to list "${path}".`);
    }

    // Dirent.isDirectory()/isFile() reflect the directory entry itself, not
    // the symlink's target - a symlink is never reported as a directory or
    // a file here, so it's never mistaken for one to recurse into.
    const allEntries = dirents
      .filter((entry) => !SKIPPED_DIRECTORIES.has(entry.name))
      .map((entry) => ({
        name: entry.name,
        type: entry.isSymbolicLink()
          ? ('symlink' as const)
          : entry.isDirectory()
            ? ('directory' as const)
            : entry.isFile()
              ? ('file' as const)
              : ('other' as const),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      path,
      entries: allEntries.slice(0, MAX_LIST_ENTRIES),
      truncated: allEntries.length > MAX_LIST_ENTRIES,
    };
  },
});

export const readFile = createTool({
  id: 'readFile',
  description: `Read a file's contents (path relative to repo root). Truncated above ${MAX_READ_FILE_BYTES} bytes - use searchFiles to jump to a section instead.`,
  inputSchema: z.object({
    path: z.string().describe('Relative to repo root.'),
  }),
  outputSchema: z.object({
    path: z.string(),
    content: z.string(),
    truncated: z.boolean(),
    totalBytes: z.number(),
  }),
  execute: async ({ path }, { requestContext }) => {
    const root = getRepositoryRoot(requestContext);
    const target = await resolveWithinRepository(root, path);
    await assertReadable(root, target, path);
    const targetStat = await statOrThrow(target, path);

    if (targetStat.isDirectory()) {
      throw new Error(`"${path}" is a directory. Use listFiles to inspect it.`);
    }

    let buffer: Buffer;
    try {
      buffer = await readFileFromDisk(target);
    } catch {
      throw new Error(`Unable to read "${path}".`);
    }

    const truncated = buffer.byteLength > MAX_READ_FILE_BYTES;
    let content = buffer.subarray(0, MAX_READ_FILE_BYTES).toString('utf8');
    if (truncated) {
      // Appended directly to the content the model sees, not just a
      // separate boolean field - a model skimming the text alone must not
      // be able to mistake this for the complete file.
      content += `\n\n[File content truncated: showing first ${MAX_READ_FILE_BYTES} bytes of ${buffer.byteLength} total bytes. Use searchFiles to locate the section you need instead of assuming the rest is irrelevant.]`;
    }

    return { path, content, truncated, totalBytes: buffer.byteLength };
  },
});

// Accepts either a plain substring or a regular expression. Models
// sometimes pass regex syntax (e.g. "func [A-Za-z]+\\(\\)") expecting grep
// -like behavior; falling back to a literal substring test only when the
// query isn't a valid regex means both styles work, and plain symbol names
// (the common case) behave identically either way.
function makeLineMatcher(query: string): (line: string) => boolean {
  try {
    const regex = new RegExp(query);
    return (line) => regex.test(line);
  } catch {
    return (line) => line.includes(query);
  }
}

export const searchFiles = createTool({
  id: 'searchFiles',
  description: 'Search the repo for a text/symbol match (plain text or regex). Optionally scope to a path.',
  inputSchema: z.object({
    query: z.string().describe('Plain text or regex.'),
    path: z.string().optional().describe('Optional path to scope to.'),
  }),
  outputSchema: z.object({
    query: z.string(),
    matches: z.array(
      z.object({
        path: z.string(),
        line: z.number(),
        text: z.string(),
      }),
    ),
    truncated: z.boolean(),
    notice: z.string().optional(),
  }),
  execute: async ({ query, path }, { requestContext }) => {
    const root = getRepositoryRoot(requestContext);
    const startPath = await resolveWithinRepository(root, path);
    const startStat = await statOrThrow(startPath, path ?? '.');
    if (!startStat.isDirectory()) await assertReadable(root, startPath, path);

    const matchesLine = makeLineMatcher(query);
    const matches: { path: string; line: number; text: string }[] = [];
    let filesScanned = 0;
    let truncated = false;
    let truncationReason: 'matches' | 'files' | undefined;

    function searchLines(absolutePath: string, buffer: Buffer) {
      const lines = buffer.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (matchesLine(lines[i])) {
          const text = lines[i].trim();
          matches.push({
            path: relative(root, absolutePath),
            line: i + 1,
            text: text.length > MAX_MATCH_LINE_LENGTH ? `${text.slice(0, MAX_MATCH_LINE_LENGTH)}…` : text,
          });
          if (matches.length >= MAX_SEARCH_MATCHES) {
            truncationReason = 'matches';
            return true;
          }
        }
      }
      return false;
    }

    async function walk(dir: string): Promise<void> {
      if (truncated) return;
      let dirents;
      try {
        dirents = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // unreadable directory - skip it rather than fail the whole search
      }

      for (const entry of dirents) {
        if (truncated) return;
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        const entryPath = join(dir, entry.name);
        if (isSecretPath(relative(root, entryPath))) continue; // credentials are never scanned, so never echoed in a match

        if (entry.isDirectory()) {
          await walk(entryPath);
          continue;
        }
        // Dirent.isFile() reflects the entry itself, not a symlink's
        // target, so symlinks (to files or directories, inside or outside
        // the repository) fall through here and are never followed.
        if (!entry.isFile()) continue;

        filesScanned += 1;
        if (filesScanned > MAX_SEARCH_FILES) {
          truncated = true;
          truncationReason = 'files';
          return;
        }

        let buffer: Buffer;
        try {
          buffer = await readFileFromDisk(entryPath);
        } catch {
          continue;
        }
        if (buffer.byteLength > MAX_SCAN_FILE_BYTES) continue;
        if (buffer.subarray(0, 8000).includes(0)) continue; // skip binary-looking files

        if (searchLines(entryPath, buffer)) {
          truncated = true;
          return;
        }
      }
    }

    if (startStat.isDirectory()) {
      await walk(startPath);
    } else {
      try {
        const buffer = await readFileFromDisk(startPath);
        searchLines(startPath, buffer);
      } catch {
        throw new Error(`Unable to read "${path ?? '.'}".`);
      }
    }

    const notice = !truncated
      ? undefined
      : truncationReason === 'matches'
        ? `Search stopped after finding ${MAX_SEARCH_MATCHES} matches; additional matches may exist. Narrow the query or scope with "path" to see more.`
        : `Search stopped after scanning ${MAX_SEARCH_FILES} files; part of the repository was not searched. Scope the search with "path" to cover a specific area.`;

    return { query, matches, truncated, notice };
  },
});

function countChangedLines(files: ReturnType<typeof parsePatch>): number {
  let count = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith('+') || line.startsWith('-')) count += 1;
      }
    }
  }
  return count;
}

/** Writes `content` to `target` atomically: either the write is fully visible, or the original file is untouched. */
async function atomicWrite(target: string, content: string): Promise<void> {
  const tempPath = join(dirname(target), `.applypatch-${randomUUID()}.tmp`);
  try {
    await writeFileToDisk(tempPath, content, 'utf8');
    await rename(tempPath, target);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

export const applyPatch = createTool({
  id: 'applyPatch',
  description: `Apply a unified diff (from \`diff -u\`/\`git diff\`) to one file, or create a new file by diffing against empty content. patch must be a real unified diff - raw source code is NOT a patch. Added lines start with '+', removed lines start with '-', unchanged context lines start with a space, and a new file's old side is "/dev/null". Example (new file):
--- /dev/null
+++ b/path/to/file.go
@@ -0,0 +1,4 @@
+package example
+
+func Example() {}
+
The @@ hunk header's line count must match the hunk's actual lines. Context/removed lines must exactly match the file's current content - read it first. Do not invent diff syntax. Limited to ${MAX_PATCH_BYTES} bytes / ${MAX_CHANGED_LINES} changed lines per call; the parent directory of a new file must already exist.`,
  inputSchema: z.object({
    path: z.string().describe('Relative to repo root.'),
    patch: z
      .string()
      .describe('A unified diff describing the change to make to this one file.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    path: z.string(),
    created: z.boolean(),
    diff: z.string(),
  }),
  execute: async ({ path, patch }, { requestContext }) => {
    const root = getRepositoryRoot(requestContext);
    const target = await resolveWritablePathWithinRepository(root, path);

    const patchBytes = Buffer.byteLength(patch, 'utf8');
    if (patchBytes > MAX_PATCH_BYTES) {
      throw new Error(
        `Patch for "${path}" is ${patchBytes} bytes, which exceeds the ${MAX_PATCH_BYTES}-byte limit. Split this into smaller, focused patches.`,
      );
    }

    let parsed: ReturnType<typeof parsePatch>;
    try {
      parsed = parsePatch(patch);
    } catch {
      throw new Error(`Could not parse "${path}"'s patch as a unified diff. Regenerate it as a standard \`diff -u\` / \`git diff\` style patch.`);
    }
    // parsePatch('') does not return an empty array - it returns a single
    // file entry with no hunks - so emptiness has to be judged by whether
    // any file entry actually carries a hunk, not by array length alone.
    if (parsed.length === 0 || parsed.every((file) => file.hunks.length === 0)) {
      throw new Error('Patch is empty. Nothing to apply.');
    }
    if (parsed.length > 1) {
      throw new Error(
        'Patch touches more than one file. applyPatch modifies exactly one file per call - split this into separate calls, one per file.',
      );
    }

    const changedLines = countChangedLines(parsed);
    if (changedLines > MAX_CHANGED_LINES) {
      throw new Error(
        `Patch for "${path}" changes ${changedLines} lines, which exceeds the ${MAX_CHANGED_LINES}-line limit. Split this into smaller, focused patches.`,
      );
    }

    let targetStat: Awaited<ReturnType<typeof stat>> | undefined;
    try {
      targetStat = await stat(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Unable to access "${path}".`);
      }
      targetStat = undefined;
    }

    if (targetStat?.isDirectory()) {
      throw new Error(`"${path}" is a directory. applyPatch only modifies or creates files.`);
    }

    const isNewFile = targetStat === undefined;
    if (isNewFile) {
      const parentStat = await stat(dirname(target)).catch(() => undefined);
      if (!parentStat || !parentStat.isDirectory()) {
        throw new Error(`Cannot create "${path}": its parent directory does not exist yet.`);
      }
    }

    let originalContent = '';
    if (!isNewFile) {
      try {
        originalContent = (await readFileFromDisk(target)).toString('utf8');
      } catch {
        throw new Error(`Unable to read "${path}".`);
      }
    }

    const patchedContent = applyUnifiedDiff(originalContent, patch, { fuzzFactor: 0 });
    if (patchedContent === false) {
      throw new Error(
        `Patch for "${path}" could not be applied because the expected context was not found. ` +
          (isNewFile
            ? 'The file does not exist yet - if you meant to create it, write the patch against empty content.'
            : 'Re-read the file with readFile and generate a new patch against its current content.'),
      );
    }

    try {
      await atomicWrite(target, patchedContent);
    } catch {
      throw new Error(`Unable to write "${path}".`);
    }

    const diff = createPatch(path, originalContent, patchedContent);

    return { success: true, path, created: isNewFile, diff };
  },
});

/**
 * Whole-file alternative to applyPatch for small files: the model supplies the
 * complete new content instead of a hand-computed unified diff. Added after a
 * live benchmark showed the local model failing at diff generation (malformed
 * tool-call JSON dropped by the runtime, or diffs with wrong hunk headers).
 * Same boundary checks, size cap and atomic write as applyPatch.
 */
export const writeFile = createTool({
  id: 'writeFile',
  description: `Replace the entire contents of one existing file (or create a new file) with the full text you provide. Provide the COMPLETE new file, not a diff or a fragment. Limited to ${MAX_PATCH_BYTES} bytes; the parent directory of a new file must already exist.`,
  inputSchema: z.object({
    path: z.string().describe('Relative to repo root.'),
    content: z.string().describe('The complete new contents of the file.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    path: z.string(),
    created: z.boolean(),
    diff: z.string(),
  }),
  execute: async ({ path, content }, { requestContext }) => {
    const root = getRepositoryRoot(requestContext);
    const target = await resolveWritablePathWithinRepository(root, path);

    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_PATCH_BYTES) {
      throw new Error(`Content for "${path}" is ${bytes} bytes, which exceeds the ${MAX_PATCH_BYTES}-byte limit.`);
    }
    if (content.trim() === '') {
      throw new Error('Content is empty. Provide the complete new file contents.');
    }

    const targetStat = await stat(target).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw new Error(`Unable to access "${path}".`);
      return undefined;
    });
    if (targetStat?.isDirectory()) throw new Error(`"${path}" is a directory. writeFile only writes files.`);

    const isNewFile = targetStat === undefined;
    if (isNewFile) {
      const parentStat = await stat(dirname(target)).catch(() => undefined);
      if (!parentStat || !parentStat.isDirectory()) {
        throw new Error(`Cannot create "${path}": its parent directory does not exist yet.`);
      }
    }

    const original = isNewFile ? '' : (await readFileFromDisk(target)).toString('utf8');
    try {
      await atomicWrite(target, content);
    } catch {
      throw new Error(`Unable to write "${path}".`);
    }
    return { success: true, path, created: isNewFile, diff: createPatch(path, original, content) };
  },
});
