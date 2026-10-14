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
  /** Execution ceiling; verifier argv is still validated by the runtime. */
  policy: LanguageDelegationPolicy;
}

export const LANGUAGE_ADAPTERS = {
  go: {
    id: 'go', extensions: ['.go'], enabled: true, workerAgentId: 'codingWorkerGo',
    conventionPath: 'docs/engineering/languages/go.md',
    policy: { maxAllowedFiles: 1, allowedExtensions: ['.go'], allowedVerificationBinaries: ['go', 'gofmt'], maxAttempts: 3 },
  },
  js: {
    id: 'js', extensions: ['.js', '.mjs', '.cjs'], enabled: true, workerAgentId: 'codingWorkerJs',
    conventionPath: 'docs/engineering/languages/javascript.md',
    policy: { maxAllowedFiles: 1, allowedExtensions: ['.js', '.mjs', '.cjs'], allowedVerificationBinaries: ['npx'], maxAttempts: 3 },
  },
  ts: {
    id: 'ts', extensions: ['.ts', '.mts', '.cts'], enabled: false,
    conventionPath: 'docs/engineering/languages/typescript.md',
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
