import { lstat, open, readFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { TEST_FILE } from '../../runtime/execution/delegation.ts';
import { dirtyEntries, headCommit, readGit, requireGitRoot } from './readonly-repo.ts';
import type { EngineeringObjective, ResearchContext } from './types.ts';

/**
 * Deterministic, read-only repository research: no model, no network, no writes. It answers "where does this live, how
 * is it tested, what is nearby and what is risky" with a compact ResearchContext (never a repository dump), so a Lead
 * (Claude or a human) can plan from evidence. Everything it reads comes from `git ls-files` and bounded file reads.
 */

export interface ResearchLimits {
  maxListedFiles: number;
  maxContentFiles: number;
  maxContentBytes: number;
  maxRelevant: number;
  maxModules: number;
}

export const DEFAULT_RESEARCH_LIMITS: ResearchLimits = { maxListedFiles: 20_000, maxContentFiles: 1_500, maxContentBytes: 64 * 1024, maxRelevant: 30, maxModules: 20 };

const STOPWORDS = new Set(
  'the and for with that this from into onto over under add adds added use uses using make makes new all any not are was were has have had can should will would our your its their per via out too but also when then than more most some such each between within without through across after before about service project repository code feature support allow ensure implement create update change'.split(' '),
);

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.go': 'go', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'jsx', '.ts': 'typescript', '.tsx': 'tsx',
  '.py': 'python', '.rs': 'rust', '.java': 'java', '.rb': 'ruby', '.php': 'php', '.cs': 'csharp', '.sql': 'sql', '.scss': 'scss', '.css': 'css', '.html': 'html',
};
const SOURCE_EXT = new Set(Object.keys(LANGUAGE_BY_EXT));
const WORKER_EXT = new Set(['.go', '.js', '.mjs', '.cjs']);
const MANIFEST_NAMES = new Set(['package.json', 'go.mod', 'pyproject.toml', 'Cargo.toml', 'tsconfig.json', 'Makefile', 'Dockerfile', 'README.md']);
const CONFIG_PATTERN = /(^|\/)(jest\.config\.[cm]?[jt]s|\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s|\.prettierrc[^/]*|\.babelrc[^/]*|babel\.config\.[cm]?[jt]s|\.golangci\.[a-z]+|\.editorconfig)$/;
const SECURITY_PATH = /(^|[/._-])(auth|login|logout|password|passwd|token|secret|credential|session|oauth|jwt|payment|billing|checkout|crypto|permission|acl|role|csrf|cors)([/._-]|$)/i;
const DESTRUCTIVE_PATH = /(^|\/)(migrations?|db\/migrate|schema\.(sql|prisma))(\/|$|\.)/i;
const SKIP_PATH = /(^|\/)(node_modules|\.git|dist|build|coverage|vendor|\.next|\.mastra)\//;
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.pdf', '.zip', '.gz', '.tgz', '.mp4', '.mov', '.woff', '.woff2', '.ttf', '.lock', '.db', '.sqlite', '.duckdb']);

/** Lowercase search tokens from free text; camelCase and snake_case are split, stopwords and tiny words dropped. */
export function keywordsOf(...texts: string[]): string[] {
  const seen = new Set<string>();
  for (const text of texts) {
    for (const word of text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length >= 3 && !STOPWORDS.has(word) && !/^\d+$/.test(word)) seen.add(word);
    }
  }
  return [...seen].sort();
}

function classify(path: string): 'source' | 'test' | 'config' | 'doc' {
  if (TEST_FILE.test(path)) return 'test';
  if (CONFIG_PATTERN.test(path)) return 'config';
  if (/\.(md|mdx|txt|rst)$/i.test(path)) return 'doc';
  return 'source';
}

/** `foo.test.js`, `foo.spec.ts`, `foo_test.go` -> `foo`. */
function stemOf(path: string): string {
  return basename(path).replace(/(_test)?\.[^.]+$/, '').replace(/\.(test|spec|hidden\.test)$/, '');
}

async function readHead(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function moduleOf(path: string, roots: Set<string>): string {
  const parts = path.split('/');
  if (parts.length === 1) return '.';
  return roots.has(parts[0]) && parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0];
}

export interface ResearchOptions {
  limits?: Partial<ResearchLimits>;
  now?: () => Date;
}

export async function scanRepository(objective: EngineeringObjective, options: ResearchOptions = {}): Promise<ResearchContext> {
  const limits = { ...DEFAULT_RESEARCH_LIMITS, ...options.limits };
  const repo = await requireGitRoot(objective.repository);
  const commit = await headCommit(repo);
  const branch = (await readGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
  const dirty = await dirtyEntries(repo);

  const listed = (await readGit(repo, ['ls-files', '-co', '--exclude-standard', '-z'])).split('\0').filter(Boolean).sort();
  const truncated = listed.length > limits.maxListedFiles;
  const files = listed.slice(0, limits.maxListedFiles).filter((p) => !SKIP_PATH.test(p) && !SKIP_EXT.has(extname(p).toLowerCase()));

  // languages and architecture boundaries
  const languages: Record<string, number> = {};
  for (const f of files) {
    const language = LANGUAGE_BY_EXT[extname(f)];
    if (language) languages[language] = (languages[language] ?? 0) + 1;
  }
  const topDirs = new Set(files.filter((f) => f.includes('/')).map((f) => f.split('/')[0]));
  const nestRoots = new Set(['src', 'lib', 'app', 'internal', 'pkg', 'cmd', 'packages', 'services'].filter((d) => topDirs.has(d)));
  const moduleCounts = new Map<string, number>();
  for (const f of files) if (SOURCE_EXT.has(extname(f))) moduleCounts.set(moduleOf(f, nestRoots), (moduleCounts.get(moduleOf(f, nestRoots)) ?? 0) + 1);
  const modules = [...moduleCounts].map(([path, count]) => ({ path, files: count })).sort((a, b) => b.files - a.files || a.path.localeCompare(b.path)).slice(0, limits.maxModules);

  // manifests, dependencies, conventions
  const manifests = files.filter((f) => f.split('/').length <= 3 && (MANIFEST_NAMES.has(basename(f)) || CONFIG_PATTERN.test(f)));
  const dependencies = new Set<string>();
  const testCommands: string[][] = [];
  const conventions: string[] = [];
  const rootPackage = files.includes('package.json') ? await readJson(join(repo, 'package.json')) : undefined;
  if (rootPackage) {
    const deps = { ...(rootPackage.dependencies as object | undefined), ...(rootPackage.devDependencies as object | undefined) };
    for (const name of Object.keys(deps).sort()) dependencies.add(name);
    const scripts = (rootPackage.scripts ?? {}) as Record<string, string>;
    if (scripts.test) testCommands.push(['npm', 'test']);
    if ('jest' in deps) {
      testCommands.push(['npx', '--no-install', 'jest']);
      conventions.push('JavaScript tests use jest');
    }
    if (rootPackage.type === 'module') conventions.push('ES modules (package.json "type": "module")');
    if ('typescript' in deps) conventions.push('TypeScript project');
  }
  if (files.includes('go.mod')) {
    const gomod = await readFile(join(repo, 'go.mod'), 'utf8').catch(() => '');
    const module = /^module\s+(\S+)/m.exec(gomod)?.[1];
    if (module) conventions.push(`Go module ${module}`);
    for (const m of gomod.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[\w.-]+\/[\w./-]+)\s+v[\w.+-]+/gm)) dependencies.add(m[1]);
    testCommands.push(['go', 'test', './...']);
    conventions.push('Go formatting via gofmt');
  }
  const testFiles = files.filter((f) => TEST_FILE.test(f));
  const sourceFiles = files.filter((f) => SOURCE_EXT.has(extname(f)) && !TEST_FILE.test(f));
  if (testFiles.length > 0) {
    const colocated = testFiles.filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$|_test\.go$/.test(f) && !/(^|\/)(tests?|__tests__)\//.test(f)).length;
    conventions.push(colocated >= testFiles.length / 2 ? `tests are co-located with sources (${testFiles.length} test files)` : `tests live in test directories (${testFiles.length} test files)`);
  } else conventions.push('no test files found');
  if (files.some((f) => CONFIG_PATTERN.test(f) && /eslint/.test(f))) conventions.push('ESLint configured');
  if (files.some((f) => /prettier/.test(f))) conventions.push('Prettier configured');

  // relevance: objective keywords against paths (strong) and file heads (weak)
  const tokens = keywordsOf(objective.title, objective.description, ...objective.constraints, ...objective.acceptanceCriteria);
  const scored = new Map<string, { score: number; reasons: string[] }>();
  const bump = (path: string, score: number, reason: string) => {
    const entry = scored.get(path) ?? { score: 0, reasons: [] };
    entry.score += score;
    entry.reasons.push(reason);
    scored.set(path, entry);
  };
  for (const f of files) {
    const lower = f.toLowerCase();
    const hits = tokens.filter((t) => lower.includes(t));
    if (hits.length > 0) bump(f, 3 * hits.length, `path matches: ${hits.join(', ')}`);
  }
  let filesRead = 0;
  for (const f of sourceFiles) {
    if (filesRead >= limits.maxContentFiles) break;
    const info = await lstat(join(repo, f)).catch(() => undefined);
    if (!info?.isFile() || info.size === 0) continue;
    filesRead++;
    const head = (await readHead(join(repo, f), limits.maxContentBytes).catch(() => '')).toLowerCase();
    const hits = tokens.filter((t) => head.includes(t));
    if (hits.length > 0) bump(f, Math.min(hits.length, 5), `content mentions: ${hits.slice(0, 5).join(', ')}`);
  }
  const ranked = [...scored].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
  const picked = new Map(ranked.slice(0, limits.maxRelevant).map(([path, v]) => [path, v] as const));
  // each relevant source file brings its tests; a relevant test brings nothing extra
  for (const [path] of [...picked]) {
    if (classify(path) !== 'source') continue;
    const stem = stemOf(path);
    for (const t of testFiles.filter((t) => stemOf(t) === stem && dirname(t).split('/')[0] === dirname(path).split('/')[0]).slice(0, 2)) {
      if (!picked.has(t)) picked.set(t, { score: 0, reasons: [`test for ${path}`] });
    }
  }
  const relevantFiles = [...picked].map(([path, v]) => ({ path, kind: classify(path), score: v.score, reasons: v.reasons })).slice(0, limits.maxRelevant + 10);

  // risks
  const risks: ResearchContext['risks'] = [];
  const relevantPaths = relevantFiles.map((f) => f.path);
  const security = relevantPaths.filter((p) => SECURITY_PATH.test(p));
  if (security.length > 0) risks.push({ kind: 'security_sensitive', detail: 'relevant files touch authentication, secrets, payment or permission code: keep with the Lead or a human', paths: security });
  const destructive = files.filter((p) => DESTRUCTIVE_PATH.test(p));
  if (destructive.length > 0 && relevantPaths.some((p) => DESTRUCTIVE_PATH.test(p) || /migrat|schema|database|\bdb\b/.test(p))) {
    risks.push({ kind: 'destructive_change', detail: 'schema or migration files are in scope: destructive changes need a human decision', paths: destructive.slice(0, 10) });
  }
  const untested = relevantFiles.filter((f) => f.kind === 'source' && !relevantFiles.some((t) => t.kind === 'test' && stemOf(t.path) === stemOf(f.path)) && !testFiles.some((t) => stemOf(t) === stemOf(f.path)));
  if (untested.length > 0) risks.push({ kind: 'no_test_coverage', detail: 'relevant source files without a matching test file', paths: untested.map((f) => f.path).slice(0, 10) });
  const unsupported = relevantFiles.filter((f) => f.kind === 'source' && !WORKER_EXT.has(extname(f.path)));
  if (unsupported.length > 0) risks.push({ kind: 'worker_unsupported_language', detail: 'local workers only edit .go/.js/.mjs/.cjs; tasks over these files stay with the Lead', paths: unsupported.map((f) => f.path).slice(0, 10) });
  const dirtyRelevant = dirty.filter((d) => relevantPaths.includes(d.path)).map((d) => d.path);
  if (dirtyRelevant.length > 0) risks.push({ kind: 'dirty_files', detail: 'relevant files have uncommitted changes; a worker task over them is blocked unless the batch snapshots them', paths: dirtyRelevant });
  const large: string[] = [];
  for (const f of relevantFiles.filter((f) => f.kind === 'source')) if (((await lstat(join(repo, f.path)).catch(() => undefined))?.size ?? 0) > 200 * 1024) large.push(f.path);
  if (large.length > 0) risks.push({ kind: 'large_file', detail: 'files over 200 KB are poor candidates for a small local model', paths: large });
  if (truncated) risks.push({ kind: 'scan_truncated', detail: `the repository lists more than ${limits.maxListedFiles} files; research covers the first ${limits.maxListedFiles}`, paths: [] });

  const linkCandidates: string[] = [];
  if (rootPackage && (await lstat(join(repo, 'node_modules')).catch(() => undefined))?.isDirectory()) linkCandidates.push('node_modules');

  return {
    schema: 'agentic.research/1',
    objectiveId: objective.id,
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    repository: repo,
    commit,
    branch: branch && branch !== 'HEAD' ? branch : null,
    dirtyFiles: dirty.map((d) => d.path).slice(0, 200),
    languages: Object.fromEntries(Object.entries(languages).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    modules,
    manifests,
    dependencies: [...dependencies].slice(0, 40),
    conventions,
    testCommands,
    linkCandidates,
    relevantFiles,
    risks,
    scan: { filesListed: listed.length, filesRead, truncated },
  };
}
