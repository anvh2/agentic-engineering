import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Mastra } from '@mastra/core/mastra';
import { AGENT_ROLES, ModelRegistry, ModelResolver } from '../../../runtime/models/index.ts';
import { createCodingWorker } from '../../../workers/coding-worker.ts';
import { fakeModelServer } from '../__testing__/fake-model-server.ts';
import { createCodingTaskWorkflow, type CodingTaskWorkflowInput, type CodingTaskWorkflowResult } from './coding-task-workflow.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

test('the default coding worker run reports agent, provider and model separately in its result, its trace file and on the wire', async () => {
  const server = await fakeModelServer('I made no changes.');
  const root = await mkdtemp(join(tmpdir(), 'ctm-repo-'));
  const artifacts = await mkdtemp(join(tmpdir(), 'ctm-artifacts-'));
  try {
    await mkdir(join(root, 'calc'));
    await writeFile(join(root, 'go.mod'), 'module example.com/calc\n\ngo 1.22\n');
    await writeFile(join(root, 'calc', 'calc.go'), 'package calc\n\nfunc Double(n int) int {\n\treturn 0\n}\n');
    await writeFile(join(root, 'calc', 'calc_test.go'), 'package calc\n\nimport "testing"\n\nfunc TestDouble(t *testing.T) {\n\tif Double(3) != 6 {\n\t\tt.Fatal("want 6")\n\t}\n}\n');
    git(root, 'init', '-q');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');

    const ref = { providerId: 'ollama', modelId: 'qwen3:8b' };
    const registry = new ModelRegistry()
      .addProvider({ providerId: 'ollama', kind: 'local', url: server.url, billing: 'local-free', credential: { env: 'OLLAMA_API_KEY', placeholder: 'ollama' }, availability: { state: 'available' } })
      .addModel({ ...ref, capabilities: { toolCalling: true, structuredOutput: true }, availability: { state: 'available' }, roles: AGENT_ROLES });
    const resolver = new ModelResolver(registry, { defaults: { 'coding-worker': ref, specialist: ref } }, { OLLAMA_API_KEY: 'key-for-test' });

    // The Mastra instance holds the worker exactly as index.ts registers it, here pointed at the loopback endpoint.
    const workflow = createCodingTaskWorkflow({ artifactRoot: artifacts, runOptions: { runtimeRetryDelayMs: 0 } });
    const mastra = new Mastra({ agents: { codingWorkerGo: createCodingWorker('go', 'writeFile', resolver) }, workflows: { coding: workflow } });
    const input: CodingTaskWorkflowInput = {
      repository: root,
      contract: { taskId: 'CTM-1', objective: 'Implement Double', allowedFiles: ['calc/calc.go'], contextFiles: ['calc/calc_test.go'], acceptanceCriteria: ['TestDouble passes'], verificationCommands: [['go', 'test', '-count=1', './...']], constraints: ['tests are immutable', 'standard library only'] },
      assessment: { complexity: 'small', risk: 'low', ambiguity: 'none', rationale: 'one function with an existing test' },
    };
    const r = await (await mastra.getWorkflow('coding').createRun()).start({ inputData: input as never });
    assert.equal(r.status, 'success');
    const result = (r as unknown as { result: CodingTaskWorkflowResult }).result;

    // The worker made no change, so the verifier (not the model) refuses: PASS stays with the runtime.
    assert.notEqual(result.status, 'PASS');
    assert.deepEqual(result.model, { agentId: 'coding-worker-go', role: 'coding-worker', providerId: 'ollama', modelId: 'qwen3:8b' });
    assert.equal(result.provider, 'ollama', 'the worker-provider id is reported separately from the model binding');

    const trace = (await readFile(join(result.artifactDir!, 'trace.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { seq: number; type: string; data: Record<string, unknown> });
    const bound = trace.filter((e) => e.type === 'model_bound');
    assert.equal(bound.length, 1);
    assert.deepEqual(bound[0]!.data, { agentId: 'coding-worker-go', agentRole: 'coding-worker', providerId: 'ollama', modelId: 'qwen3:8b' });
    assert.ok(bound[0]!.seq < trace.find((e) => e.type === 'model_started')!.seq, 'the binding is recorded before the first model call');
    assert.ok(!JSON.stringify(trace).includes('key-for-test'), 'no credential in the trace');

    assert.ok(server.seen.length >= 1);
    assert.ok(server.seen.every((s) => s.model === 'qwen3:8b' && s.authorization === 'Bearer key-for-test' && s.tools.includes('runGoTest')));
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
});
