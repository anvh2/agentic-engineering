import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RequestContext } from '@mastra/core/request-context';
import { codingTaskWorkflow } from './coding-task-workflow.ts';
import { codingWorker } from '../agents/coding-worker.ts';
import { readFile } from '../tools/repository-tools.ts';
import { createFixtureRepo, type FixtureRepo } from '../tools/__testing__/fixture-repo.ts';
import { callTool } from '../tools/__testing__/call-tool.ts';

/**
 * Exercises the real workflow (codingTaskWorkflow.createRun().start(...)),
 * not a reimplementation of its wiring - only the model boundary is
 * stubbed. codingWorker.generate() is what would otherwise call out to a
 * live Ollama server; everything upstream of it (workflow engine,
 * RequestContext construction, delegation input) runs unmodified.
 *
 * This deliberately does NOT talk to Ollama or the Claude CLI, so it stays
 * fast and deterministic in the automated suite. The full
 * workflow -> agent -> Ollama -> tools path is covered manually by
 * `npm run workflow:demo` / `npm run supervisor:demo`.
 */
describe('codingTaskWorkflow repository-context wiring (model boundary stubbed)', () => {
  let repoA: FixtureRepo;
  let repoB: FixtureRepo;
  let capturedRequestContext: RequestContext | undefined;
  const originalGenerate = codingWorker.generate.bind(codingWorker);

  before(async () => {
    repoA = await createFixtureRepo('RepoAMarker', { dirName: 'repo-a' });
    repoB = await createFixtureRepo('RepoBMarker', { parent: repoA.parent, dirName: 'repo-b' });

    (codingWorker as unknown as { generate: typeof codingWorker.generate }).generate = (async (
      _messages: unknown,
      options?: { requestContext?: RequestContext },
    ) => {
      capturedRequestContext = options?.requestContext;
      return { text: 'stubbed worker response', finishReason: 'stop' };
    }) as typeof codingWorker.generate;
  });

  after(async () => {
    (codingWorker as unknown as { generate: typeof codingWorker.generate }).generate = originalGenerate;
    await repoA.cleanup();
  });

  it('propagates repository A into the request context the tool layer sees', async () => {
    capturedRequestContext = undefined;
    const run = await codingTaskWorkflow.createRun();
    const result = await run.start({ inputData: { task: 'inspect repo A', repository: repoA.root } });

    assert.equal(result.status, 'success');
    assert.ok(capturedRequestContext, 'expected codingWorker.generate to receive a requestContext');

    const fileResult = await callTool(
      readFile.execute!(
        { path: 'internal/service.go' },
        { requestContext: capturedRequestContext } as any,
      ),
    );
    assert.match(fileResult.content, /RepoAMarker/);
    assert.doesNotMatch(fileResult.content, /RepoBMarker/);
  });

  it('propagates repository B into the request context for a separate run, independent of the previous one', async () => {
    capturedRequestContext = undefined;
    const run = await codingTaskWorkflow.createRun();
    await run.start({ inputData: { task: 'inspect repo B', repository: repoB.root } });

    assert.ok(capturedRequestContext);
    const fileResult = await callTool(
      readFile.execute!(
        { path: 'internal/service.go' },
        { requestContext: capturedRequestContext } as any,
      ),
    );
    assert.match(fileResult.content, /RepoBMarker/);
    assert.doesNotMatch(fileResult.content, /RepoAMarker/);
  });

  it('runs without a repository and leaves the tool layer failing closed - no fallback to a previous run', async () => {
    capturedRequestContext = undefined;
    const run = await codingTaskWorkflow.createRun();
    const result = await run.start({ inputData: { task: 'inspect with no repository configured' } });

    assert.equal(result.status, 'success');
    assert.equal(capturedRequestContext, undefined, 'expected no requestContext to be built without a repository');

    await assert.rejects(
      () =>
        readFile.execute!(
          { path: 'internal/service.go' },
          { requestContext: undefined } as any,
        ),
      /No repository is configured/,
    );
  });
});
