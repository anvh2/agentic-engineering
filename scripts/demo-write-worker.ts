import { mkdir, mkdtemp, readFile as readRaw, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestContext } from '@mastra/core/request-context';
import { codingWorker } from '../src/mastra/agents/coding-worker.ts';
import { REPOSITORY_ROOT_CONTEXT_KEY } from '../src/mastra/tools/repository-tools.ts';

// A throwaway fixture repository, not the real vus-metadata-v2 checkout -
// this demo exercises write access, so it must never run against a real
// repository the user cares about.
const parent = await mkdtemp(join(tmpdir(), 'write-worker-demo-'));
const repoRoot = join(parent, 'repo');
await mkdir(join(repoRoot, 'internal'), { recursive: true });
await writeFile(join(repoRoot, 'go.mod'), 'module example.com/demo\n\ngo 1.22\n');
await writeFile(
  join(repoRoot, 'internal', 'math.go'),
  'package internal\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n',
);

console.log(`Fixture repository created at ${repoRoot}\n`);

const prompt = `Task: Add unit tests for the Add function in internal/math.go.

Inspect the repository first with listFiles and readFile.
No test file exists yet for this package - create internal/math_test.go using Go's standard testing package, in a table-driven style.
Modify only internal/math_test.go. Do not modify internal/math.go or any other file.
Cover positive numbers, zero, and negative numbers.
Do not use runGoFmt or runGoTest for this task - only listFiles, readFile, and applyPatch.

applyPatch's patch argument must be a plain unified diff with exactly this
shape - a "---"/"+++" file header line pair, then one or more "@@ ... @@"
hunks. Do not add "diff --git", "index", or "new file mode" lines; they are
not needed and will not be parsed. For a brand new file, the patch looks
like this (using a different example file and content than your real task):

--- /dev/null
+++ example.go
@@ -0,0 +1,3 @@
+package example
+
+var X = 1

Follow that exact shape when you call applyPatch.`;

const requestContext = new RequestContext();
requestContext.set(REPOSITORY_ROOT_CONTEXT_KEY, repoRoot);

console.log(`Sending write task to codingWorker via ${process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'} ...\n`);

const response = await codingWorker.generate(prompt, { requestContext });

console.log('finishReason:', (response as any).finishReason);
console.log('steps:', (response as any).steps?.length);
for (const step of (response as any).steps ?? []) {
  for (const content of (step as { content?: unknown[] }).content ?? []) {
    const c = content as { type?: string; toolName?: string; input?: unknown; text?: string };
    if (c.type === 'tool-call') {
      console.log(`  [tool-call] ${c.toolName}`, JSON.stringify(c.input)?.slice(0, 150));
    } else if (c.type === 'text' && c.text) {
      console.log(`  [text] ${c.text.slice(0, 150).replace(/\n/g, ' ')}`);
    } else if (c.type === 'reasoning') {
      console.log(`  [reasoning] (omitted)`);
    }
  }
}

type ApplyPatchOutput = { success: boolean; path: string; created: boolean; diff: string };

// Tool output content parts come wrapped as { type: 'json', value: <actual output> }
// rather than the raw output directly - unwrap that shape if present.
function unwrapToolOutput(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && 'value' in (raw as Record<string, unknown>) && (raw as any).type === 'json') {
    return (raw as any).value;
  }
  return raw;
}

function extractApplyPatchCalls(res: unknown): { output: unknown; isError: boolean }[] {
  const results: { output: unknown; isError: boolean }[] = [];
  for (const step of (res as { steps?: unknown[] }).steps ?? []) {
    for (const content of (step as { content?: unknown[] }).content ?? []) {
      const c = content as { type?: string; toolName?: string; output?: unknown; result?: unknown; isError?: boolean };
      if (c.type === 'tool-result' && c.toolName === 'applyPatch') {
        results.push({ output: unwrapToolOutput(c.output ?? c.result), isError: Boolean(c.isError) });
      }
    }
  }
  return results;
}

const applyPatchCalls = extractApplyPatchCalls(response);
console.log(`\napplyPatch was called ${applyPatchCalls.length} time(s):`);
for (const call of applyPatchCalls) {
  console.log(`  isError=${call.isError} ->`, JSON.stringify(call.output)?.slice(0, 300));
}

const patchResults = applyPatchCalls
  .map((call) => call.output as ApplyPatchOutput)
  .filter((output) => output?.success);

console.log('Files changed:');
if (patchResults.length === 0) {
  console.log('  (none - the worker did not successfully apply any patch)');
} else {
  for (const result of patchResults) {
    console.log(`  ${result.created ? '(new) ' : ''}${result.path}`);
  }
}

console.log('\nDiff:');
for (const result of patchResults) {
  console.log(result.diff);
}

console.log('\nWorker summary:\n');
console.log(response.text);

console.log('\nVerification (reading the fixture repository directly from disk):');
try {
  const testFileContent = await readRaw(join(repoRoot, 'internal', 'math_test.go'), 'utf8');
  console.log('  internal/math_test.go exists:\n');
  console.log(testFileContent);
} catch {
  console.log('  internal/math_test.go was NOT created.');
}
const mathGoContent = await readRaw(join(repoRoot, 'internal', 'math.go'), 'utf8');
console.log(
  '  internal/math.go unchanged:',
  mathGoContent === 'package internal\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n',
);

await rm(parent, { recursive: true, force: true });
console.log('\nFixture repository cleaned up.');
