import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { LANGUAGE_ADAPTERS, detectLanguage } from './language-adapters.ts';

/**
 * Shared engineering contract stays independent of implementation language.
 * The caller must supply an approved design; never invent HLD/LLD from worker prose.
 */
export interface ApprovedDesign {
  hld: string;
  lld: string;
  approvalRef: string;
  adr?: string[];
}

const CONVENTIONS = {
  go: [
    'Preserve the approved HLD/LLD and acceptance invariants.',
    'Follow package boundaries and explicit error handling; propagate context cancellation.',
    'Use idiomatic Go naming; run gofmt and the approved targeted go test verifier.',
  ],
  js: [
    'Preserve the approved HLD/LLD and acceptance invariants.',
    'Respect module format (CommonJS/ESM), async error handling and module boundaries.',
    'Do not add dependencies; run the approved offline, scoped Jest verifier.',
  ],
  ts: [
    'Preserve the approved HLD/LLD and acceptance invariants.',
    'Preserve tsconfig, strict typing and ESM conventions; validate untrusted data at runtime.',
    'Do not add dependencies; TypeScript delegation is disabled until its verifier is approved.',
  ],
} as const;

export interface EngineeringContext {
  language: keyof typeof LANGUAGE_ADAPTERS;
  manifestHash: string;
  text: string;
}

export function buildEngineeringContext(files: string[], design?: ApprovedDesign): EngineeringContext {
  const language = detectLanguage(files.map((file) => extname(file)));
  if (!language) throw new Error('engineering_context: unknown or mixed implementation language');
  if (design && (!design.hld.trim() || !design.lld.trim() || !design.approvalRef.trim())) {
    throw new Error('engineering_context: approved design requires HLD, LLD and approvalRef');
  }
  const adapter = LANGUAGE_ADAPTERS[language];
  const sections = [
    'Shared engineering rules: HLD and LLD govern implementation; language style never overrides approved invariants.',
    'Only the runtime verifier and independent reviewer may approve a change. Do not edit tests, Oracle, protected files or task scope.',
    `Implementation language: ${language}. Convention reference: ${adapter.conventionPath}.`,
    `Language conventions:\n${CONVENTIONS[language].map((line) => `- ${line}`).join('\n')}`,
  ];
  if (design) {
    sections.push(`Approved design reference: ${design.approvalRef}`);
    sections.push(`HLD (approved, read-only):\n${design.hld}`);
    sections.push(`LLD (approved, read-only):\n${design.lld}`);
    if (design.adr?.length) sections.push(`ADR decisions (approved, read-only):\n${design.adr.map((a) => `- ${a}`).join('\n')}`);
  } else {
    sections.push('No approved HLD/LLD attached. Follow the task contract and supplied contextFiles; never invent an architectural approval.');
  }
  const body = sections.join('\n\n');
  // Deterministic provenance of exactly the context injected in the model prompt.
  const manifestHash = createHash('sha256').update(body).digest('hex');
  return { language, manifestHash, text: `Engineering context SHA-256: ${manifestHash}\n\n${body}` };
}
