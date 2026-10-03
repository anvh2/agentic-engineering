import { Agent } from '@mastra/core/agent';
import { applyPatch, listFiles, readFile, searchFiles } from '../tools/repository-tools.ts';
import { gitDiff, gitStatus, runGoFmt, runGoTest, runJestTest, runPrettier } from '../tools/execution-tools.ts';
import { resolveMaxRepairAttempts } from '../workflows/repair-loop-tracker.ts';

const ollamaBaseUrl = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/$/, '');
const ollamaModel = process.env.OLLAMA_MODEL ?? 'qwen3:8b';
const maxRepairAttempts = resolveMaxRepairAttempts();

export type Ecosystem = 'go' | 'js';

const modelConfig = {
  providerId: 'ollama',
  modelId: ollamaModel,
  // Ollama exposes an OpenAI-compatible API under /v1.
  url: `${ollamaBaseUrl}/v1`,
  apiKey: process.env.OLLAMA_API_KEY || 'ollama',
} as const;

// Mastra defaults generate()/stream() to maxSteps: 5. Repository exploration
// plus a patch/format/test/repair cycle (list, read, patch, format, test,
// and possibly a corrective patch/format/test round) routinely needs more
// turns than that - without this, the worker can burn its whole step
// budget on tool calls and get cut off before producing any final text.
const defaultOptions = { maxSteps: 40 } as const;

/**
 * Two ecosystem-specific tool sets, never merged into one worker. This
 * project's local Ollama models run with small context windows and have
 * been observed (documented in PROGRESS.md, Step 11) to stall mid-task as
 * the tool count and instruction length grow - giving a single worker both
 * Go *and* JS tools would roughly double its schema/instruction footprint
 * for no benefit on any single run, since a repository is only ever one
 * ecosystem at a time. `codingTaskWorkflow` auto-detects which one to use
 * per run (go.mod vs package.json) rather than asking the model to guess.
 */
function createCodingWorker(ecosystem: Ecosystem): Agent {
  const isGo = ecosystem === 'go';

  const toolsDescription = isGo
    ? 'runGoFmt - format one file. runGoTest - `go test` for a package.'
    : 'runPrettier - format one file you just created/rewrote (this repository is not fully prettier-clean, so avoid running it on files you only partially edited). runJestTest - `jest` scoped to a test file or directory.';

  const verifyStep = isGo
    ? 'runGoFmt the changed file, then runGoTest the affected package (or "./...").'
    : 'runPrettier the changed file (only if you created/fully rewrote it), then runJestTest scoped to the test file or directory you touched.';

  return new Agent({
    id: `coding-worker-${ecosystem}`,
    name: `Coding Worker (${ecosystem === 'go' ? 'Go' : 'JavaScript'})`,
    description: `A worker that inspects, patches, formats, and tests a delegated ${isGo ? 'Go' : 'JavaScript/Node'} repository using a local Ollama model, with narrowly scoped write and verification tools.`,
    instructions: `You are a repository coding worker for the assigned ${isGo ? 'Go' : 'JavaScript/Node'} repository. No arbitrary shell access.

Tools: listFiles, readFile, searchFiles (regex or plain text, scans everything), gitStatus, gitDiff - all read-only. applyPatch - unified diff to one file, or create a new file. ${toolsDescription}

Grounding: only state a path, function, or signature you actually saw in a readFile result this conversation. Don't invent structure. A zero-result search doesn't mean nothing exists - try a different query before concluding that.

To make a change:
1. listFiles/searchFiles/readFile the target and its existing tests/conventions.
2. applyPatch a minimal diff based on content you just read. Stale-context failure -> re-read, retry.
3. ${verifyStep}
4. Test failure -> diagnose from its output, one corrective applyPatch, re-verify. Stop after ${maxRepairAttempts} corrective attempts or on success; report the last test result either way.

Never claim a command ran or a change is tested unless a tool call in this conversation confirmed it. No repository or a failing tool call -> say so plainly.`,
    model: modelConfig,
    tools: isGo
      ? { listFiles, readFile, searchFiles, applyPatch, runGoFmt, runGoTest, gitDiff, gitStatus }
      : { listFiles, readFile, searchFiles, applyPatch, runPrettier, runJestTest, gitDiff, gitStatus },
    defaultOptions,
  });
}

export const codingWorkerGo = createCodingWorker('go');
export const codingWorkerJs = createCodingWorker('js');

/** Kept for existing callers (scripts, tests) that reference the original single-worker export - equivalent to codingWorkerGo. */
export const codingWorker = codingWorkerGo;
