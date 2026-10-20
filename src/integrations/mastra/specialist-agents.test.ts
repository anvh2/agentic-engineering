import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import { findProjectRoot } from '../../core/paths.ts';
import { TOOL_CLASSES } from '../../runtime/knowledge/engineering-hooks.ts';
import { loadPackRegistry } from '../../runtime/knowledge/packs/loader.ts';
import { REPOSITORY_ROOT_CONTEXT_KEY } from '../../workers/tools/repository-tools.ts';
import { createFixtureRepo } from '../../workers/tools/__testing__/fixture-repo.ts';
import { assertReadOnlyToolTable, createMastraSpecialist, declaredContextTokens, registerSpecialists, specialistAgentId, specialistModelConfig, specialistRegistryKey, SPECIALIST_TOOL_TABLE, MAX_SPECIALISTS } from './specialist-agents.ts';
import { report, scriptedModel } from './__testing__/scripted-model.ts';

const root = findProjectRoot()!;
const pack = loadPackRegistry(root);

test('every manifest is materialized as a Mastra agent with a stable id and exactly its declared read-only tools', async () => {
  const { agents, error } = registerSpecialists(pack);
  assert.equal(error, undefined);
  assert.deepEqual(Object.keys(agents).sort(), pack.agents.map(specialistRegistryKey).sort());
  for (const manifest of pack.agents) {
    const agent = agents[specialistRegistryKey(manifest)]!;
    assert.equal(agent.id, specialistAgentId(manifest));
    assert.equal(agent.name, manifest.name);
    const tools = Object.keys(await agent.listTools()).sort();
    assert.deepEqual(tools, [...manifest.tools].sort(), manifest.id);
    for (const t of tools) assert.equal(TOOL_CLASSES[t], 'read', `${manifest.id} holds non-read tool ${t}`);
  }
});

test('constructing every specialist makes no model call', () => {
  const scripted = scriptedModel([{ text: report() }]);
  const { agents } = registerSpecialists(pack, { model: scripted.model });
  assert.equal(Object.keys(agents).length, pack.agents.length);
  assert.equal(scripted.calls(), 0, 'registration must not trigger inference');
});

test('registration is bounded in memory: constructing the whole catalog stays within a small heap budget', () => {
  globalThis.gc?.();
  const before = process.memoryUsage().heapUsed;
  const { agents } = registerSpecialists(pack);
  const grewMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
  assert.equal(Object.keys(agents).length, pack.agents.length);
  assert.ok(grewMb < 64, `registering ${pack.agents.length} specialists grew the heap by ${grewMb.toFixed(1)} MiB`);
  assert.ok(pack.agents.length <= MAX_SPECIALISTS);
});

test('the specialist tool table is read-only and a manifest cannot add to it', () => {
  assertReadOnlyToolTable();
  for (const id of Object.keys(SPECIALIST_TOOL_TABLE)) assert.equal(TOOL_CLASSES[id], 'read');
  const forged = { ...pack.agents[0]!, tools: ['readFile', 'writeFile'] };
  assert.throws(() => createMastraSpecialist(forged), /not in the read-only table/);
  assert.throws(() => createMastraSpecialist({ ...pack.agents[0]!, tools: ['__proto__'] }), /not in the read-only table/);
});

test('a pack that cannot load registers no specialists and says why, without throwing', () => {
  const missing = registerSpecialists('/nonexistent-root-for-test');
  assert.deepEqual(Object.keys(missing.agents), []);
  assert.match(missing.error!, /cannot read/);
  const noRoot = registerSpecialists(null);
  assert.match(noRoot.error!, /project root not found/);
});

test('specialists register in a real Mastra instance and are retrievable by their stable keys', () => {
  const { agents } = registerSpecialists(pack);
  const mastra = new Mastra({ agents });
  for (const manifest of pack.agents) assert.equal(mastra.getAgent(specialistRegistryKey(manifest) as never).id, specialistAgentId(manifest));
  assert.equal(Object.keys(mastra.listAgents()).length, pack.agents.length);
});

test('model configuration reads the environment without contacting it, and context size is never guessed', () => {
  assert.equal(specialistModelConfig({ OLLAMA_BASE_URL: 'http://h:1/', OLLAMA_MODEL: 'm' }).url, 'http://h:1/v1');
  assert.equal(specialistModelConfig({}).modelId, 'qwen3:8b');
  assert.equal(declaredContextTokens({}), undefined);
  assert.equal(declaredContextTokens({ OLLAMA_NUM_CTX: 'abc' }), undefined);
  assert.equal(declaredContextTokens({ OLLAMA_NUM_CTX: '16384' }), 16384);
});

test('RequestContext reaches the repository tools through a real agent run; a missing context fails safely with no data returned', async () => {
  const fixture = await createFixtureRepo('CalculateTotal');
  try {
    const manifest = pack.agentById.get('go-reviewer')!;
    const withRoot = scriptedModel([{ toolCall: { name: 'readFile', args: { path: 'internal/service.go' } } }, { text: report() }]);
    const rc = new RequestContext();
    rc.set(REPOSITORY_ROOT_CONTEXT_KEY, fixture.root);
    const ok = await createMastraSpecialist(manifest, { model: withRoot.model }).generate('review', { requestContext: rc, maxSteps: 3 });
    assert.equal(ok.text, report());
    assert.match(withRoot.seenText(), /func CalculateTotal/, 'the file content reached the model via the tool');

    const withoutRoot = scriptedModel([{ toolCall: { name: 'readFile', args: { path: 'internal/service.go' } } }, { text: report() }]);
    await createMastraSpecialist(manifest, { model: withoutRoot.model }).generate('review', { requestContext: new RequestContext(), maxSteps: 3 });
    assert.doesNotMatch(withoutRoot.seenText(), /func CalculateTotal/, 'no repository configured -> no content');
    assert.match(withoutRoot.seenText(), /No repository is configured/);
  } finally { await fixture.cleanup(); }
});

test('a specialist cannot call a tool outside its manifest even if the model asks for one', async () => {
  const fixture = await createFixtureRepo();
  try {
    const manifest = pack.agentById.get('documentation-reviewer')!; // tools: listFiles, readFile, searchFiles only
    assert.ok(!manifest.tools.includes('gitDiff'));
    const scripted = scriptedModel([{ toolCall: { name: 'gitDiff', args: {} } }, { toolCall: { name: 'writeFile', args: { path: 'README.md', content: 'pwned' } } }, { text: report() }]);
    const rc = new RequestContext();
    rc.set(REPOSITORY_ROOT_CONTEXT_KEY, fixture.root);
    await createMastraSpecialist(manifest, { model: scripted.model }).generate('review', { requestContext: rc, maxSteps: 5 });
    const seen = scripted.seenText();
    assert.match(seen, /Tool \\\"gitDiff\\\" not found\. Available tools: listFiles, readFile, searchFiles/, 'the model was told the tool does not exist for this role');
    assert.match(seen, /Tool \\\"writeFile\\\" not found/);
    const { readFile } = await import('node:fs/promises');
    assert.match(await readFile(`${fixture.root}/README.md`, 'utf8'), /Fixture repository/, 'the file was not modified');
  } finally { await fixture.cleanup(); }
});
