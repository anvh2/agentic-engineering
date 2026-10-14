/**
 * Data-only registry for language-specific coding conventions and permission ceilings.
 *
 * The Engineering Lead's HLD/LLD, DAG, review, sandbox, retry budget and pinned
 * acceptance remain common. Registering an extension NEVER authorizes delegation:
 * the adapter must be enabled only after its verifier and benchmark are approved.
 */
export interface LanguageDelegationPolicy {
  maxAllowedFiles: number;
  allowedExtensions: string[];
  allowedVerificationBinaries: string[];
  maxAttempts: number;
}

export interface LanguageAdapter {
  id: 'go' | 'js' | 'ts';
  extensions: readonly string[];
  /** Only enabled adapters can be delegated to local workers. */
  enabled: boolean;
  /** Mastra worker registration key. Undefined means there is no worker yet. */
  workerAgentId?: 'codingWorkerGo' | 'codingWorkerJs';
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
    id: 'ts', extensions: ['.ts', '.mts', '.cts'], enabled: false,
    conventionPath: 'docs/engineering/languages/typescript.md',
    conventions: ['Preserve approved HLD/LLD and acceptance invariants.', 'Preserve tsconfig, strict typing and ESM conventions; validate untrusted data at runtime.', 'Do not add dependencies; TypeScript delegation is disabled until its verifier is approved.'],
    policy: { maxAllowedFiles: 1, allowedExtensions: ['.ts', '.mts', '.cts'], allowedVerificationBinaries: [], maxAttempts: 3 },
  },
} as const satisfies Record<string, LanguageAdapter>;

export type EnabledLanguage = 'go' | 'js';
export type RegisteredLanguage = keyof typeof LANGUAGE_ADAPTERS;

export function detectLanguage(extensions: readonly string[]): RegisteredLanguage | undefined {
  if (extensions.length === 0) return undefined;
  const matches = Object.values(LANGUAGE_ADAPTERS).filter((a) =>
    extensions.every((ext) => (a.extensions as readonly string[]).includes(ext)),
  );
  return matches.length === 1 ? matches[0].id : undefined;
}

export function delegatableLanguage(extensions: readonly string[]): EnabledLanguage | undefined {
  const language = detectLanguage(extensions);
  return language && LANGUAGE_ADAPTERS[language].enabled ? language as EnabledLanguage : undefined;
}
