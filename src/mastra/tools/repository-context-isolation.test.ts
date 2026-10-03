import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RequestContext } from '@mastra/core/request-context';
import { REPOSITORY_ROOT_CONTEXT_KEY, readFile, searchFiles } from './repository-tools.ts';
import { createFixtureRepo, type FixtureRepo } from './__testing__/fixture-repo.ts';
import { callTool } from './__testing__/call-tool.ts';

/**
 * Exercises the same wiring the workflow uses (see
 * runCodingWorkerStep in ../workflows/coding-task-workflow.ts):
 * a fresh RequestContext per run, with REPOSITORY_ROOT_CONTEXT_KEY set to
 * the delegation's repository, threaded into a tool call.
 *
 * This intentionally stops at the RequestContext -> repository-tools
 * boundary rather than driving the full codingTaskWorkflow, since the
 * workflow's step calls codingWorker.generate() against a live Ollama
 * model - unsuitable for a fast, deterministic unit suite. The full
 * wiring (workflow -> agent -> Ollama -> tools) is covered by
 * `npm run workflow:demo` against a real repository.
 */
function requestContextFor(root: string): RequestContext {
  const requestContext = new RequestContext();
  requestContext.set(REPOSITORY_ROOT_CONTEXT_KEY, root);
  return requestContext;
}

describe('RequestContext repository isolation', () => {
  let repoA: FixtureRepo;
  let repoB: FixtureRepo;

  before(async () => {
    // Both fixtures share one parent directory so repoA.root and repoB.root
    // are true siblings, matching the "repository A cannot traverse into
    // repository B" scenario below.
    repoA = await createFixtureRepo('RepoAMarker', { dirName: 'repo-a' });
    repoB = await createFixtureRepo('RepoBMarker', { parent: repoA.parent, dirName: 'repo-b' });
  });

  after(async () => {
    await repoA.cleanup();
  });

  it('resolves the same relative path against each run\'s own repository', async () => {
    const resultA = await callTool(
      readFile.execute!({ path: 'internal/service.go' }, { requestContext: requestContextFor(repoA.root) } as any),
    );
    const resultB = await callTool(
      readFile.execute!({ path: 'internal/service.go' }, { requestContext: requestContextFor(repoB.root) } as any),
    );

    assert.match(resultA.content, /RepoAMarker/);
    assert.doesNotMatch(resultA.content, /RepoBMarker/);
    assert.match(resultB.content, /RepoBMarker/);
    assert.doesNotMatch(resultB.content, /RepoAMarker/);
  });

  it('a search under repository A never surfaces repository B content', async () => {
    const result = await callTool(
      searchFiles.execute!({ query: 'RepoBMarker' }, { requestContext: requestContextFor(repoA.root) } as any),
    );
    assert.deepEqual(result.matches, []);
  });

  it('repository A cannot traverse into repository B even though they share a parent directory', async () => {
    // repoA.root and repoB.root are siblings under the same parent, so
    // reaching from A into B requires walking through the shared parent -
    // exactly the traversal resolveWithinRepository blocks.
    const relativeToB = '../repo-b/internal/service.go';
    await assert.rejects(
      () =>
        readFile.execute!(
          { path: relativeToB },
          { requestContext: requestContextFor(repoA.root) } as any,
        ),
      /outside the repository root/,
    );
  });

  it('an empty RequestContext cannot fall back to a previously used repository', async () => {
    // Guards against accidental state leakage if a tool implementation ever
    // cached the last-seen root instead of reading it fresh per call.
    await readFile.execute!({ path: 'internal/service.go' }, { requestContext: requestContextFor(repoA.root) } as any);

    await assert.rejects(
      () => readFile.execute!({ path: 'internal/service.go' }, { requestContext: new RequestContext() } as any),
      /No repository is configured/,
    );
  });
});
