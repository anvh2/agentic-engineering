/**
 * Data-only registry for language-specific coding conventions and permission ceilings.
 *
 * The Engineering Lead's HLD/LLD, DAG, review, sandbox, retry budget and pinned
 * acceptance remain common. Registering an extension NEVER authorizes delegation:
 * experimental adapters remain behind their own fail-closed runtime gate until verifier and benchmark approval.
 */
export interface LanguageDelegationPolicy {
  maxAllowedFiles: number;
  allowedExtensions: string[];
  allowedVerificationBinaries: string[];
  maxAttempts: number;
  verifierProfile?: 'typescript-strict-v1';
}

export interface LanguageAdapter {
  id: 'go' | 'js' | 'ts';
  extensions: readonly string[];
  /** Registry capability. A separate feature flag may further gate an enabled adapter. */
  enabled: boolean;
  /** Mastra worker registration key. Undefined means there is no worker yet. */
  workerAgentId?: 'codingWorkerGo' | 'codingWorkerJs' | 'codingWorkerTs';
  /** Human-readable convention reference, loaded as task context by the Lead. */
  conventionPath: string;
  /** Concise worker-facing rules (also versioned and fingerprinted in task context). */
  conventions: readonly string[];
  /** Execution ceiling; verifier argv is still validated by the runtime. */
  policy: LanguageDelegationPolicy;
}

export const LANGUAGE_ADAPTERS = {
  go: {
    id: 'go', extensions: ['.go'], enabled: true, workerAgentId: 'codingWorkerGo',
    conventionPath: 'docs/engineering/languages/go.md',
    conventions: ['Preserve approved HLD/LLD and acceptance invariants.', 'Follow package boundaries and explicit error handling; propagate context cancellation.', 'Use idiomatic Go naming; run gofmt and approved targeted go test verifier.'],
    policy: { maxAllowedFiles: 1, allowedExtensions: ['.go'], allowedVerificationBinaries: ['go', 'gofmt'], maxAttempts: 3 },
  },
  js: {
    id: 'js', extensions: ['.js', '.mjs', '.cjs'], enabled: true, workerAgentId: 'codingWorkerJs',
    conventionPath: 'docs/engineering/languages/javascript.md',
    conventions: ['Preserve approved HLD/LLD and acceptance invariants.', 'Respect module format (CommonJS/ESM), async error handling and module boundaries.', 'Do not add dependencies; run approved offline, scoped Jest verifier.'],
    policy: { maxAllowedFiles: 1, allowedExtensions: ['.js', '.mjs', '.cjs'], allowedVerificationBinaries: ['npx'], maxAttempts: 3 },
  },
  ts: {
    id: 'ts', extensions: ['.ts'], enabled: true, workerAgentId: 'codingWorkerTs',
    conventionPath: 'docs/engineering/languages/typescript.md',
    conventions: ['Preserve approved HLD/LLD and acceptance invariants.', 'Preserve package tsconfig, strict typing and module conventions; validate untrusted data at runtime.', 'Do not add dependencies or edit tests, manifests, lockfiles or tsconfig files.', 'The runtime runs the pinned local TypeScript compiler and immutable Node test files; do not run shell commands.'],
    policy: { maxAllowedFiles: 4, allowedExtensions: ['.ts'], allowedVerificationBinaries: ['node'], maxAttempts: 3, verifierProfile: 'typescript-strict-v1' },
  },
} as const satisfies Record<string, LanguageAdapter>;

export type EnabledLanguage = 'go' | 'js' | 'ts';
export type RegisteredLanguage = keyof typeof LANGUAGE_ADAPTERS;

/** Runtime kill switch. Only the literal value "true" opens TS routing; unset, malformed and alternate truthy values fail closed. */
export function typeScriptDelegationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENTIC_TS_DELEGATION === 'true';
}

export function detectLanguage(extensions: readonly string[]): RegisteredLanguage | undefined {
  if (extensions.length === 0) return undefined;
  const matches = Object.values(LANGUAGE_ADAPTERS).filter((a) =>
    extensions.every((ext) => (a.extensions as readonly string[]).includes(ext)),
  );
  return matches.length === 1 ? matches[0].id : undefined;
}

export function delegatableLanguage(extensions: readonly string[], env: NodeJS.ProcessEnv = process.env): EnabledLanguage | undefined {
  const language = detectLanguage(extensions);
  if (!language || !LANGUAGE_ADAPTERS[language].enabled) return undefined;
  if (language === 'ts' && !typeScriptDelegationEnabled(env)) return undefined;
  return language as EnabledLanguage;
}
