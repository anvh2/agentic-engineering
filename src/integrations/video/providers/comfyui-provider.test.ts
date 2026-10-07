import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComfyUiVideoTransformationProvider, substituteTokens } from './comfyui-provider.ts';
import { VideoTransformError, type ProviderTransformInput } from '../types.ts';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

function binaryResponse(bytes: Uint8Array, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => {
      throw new Error('not json');
    },
    text: async () => '',
    arrayBuffer: async () => bytes.buffer,
  } as unknown as Response;
}

function withFetchQueue(responses: Array<Response | (() => Response) | (() => Promise<Response>) | Error>): () => void {
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (..._args: Parameters<typeof fetch>) => {
    const next = responses[i++];
    if (next === undefined) throw new Error('fetch called more times than expected by the test');
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next();
    return next;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function baseTransformInput(overrides: Partial<ProviderTransformInput> = {}): ProviderTransformInput {
  return {
    framesDir: '/work/frames',
    framePattern: 'frame-%06d.png',
    fps: 24,
    width: 512,
    height: 512,
    characterReference: '/refs/character.jpg',
    appearanceVariation: 'subtle',
    workDir: '/work',
    ...overrides,
  };
}

describe('substituteTokens', () => {
  it('replaces {{TOKEN}} occurrences in string leaves throughout a nested structure', () => {
    const input = { a: '{{FOO}}', b: { c: ['{{FOO}}-{{BAR}}', 'plain'] }, d: 3 };
    const result = substituteTokens(input, { FOO: 'x', BAR: 'y' });
    assert.deepEqual(result, { a: 'x', b: { c: ['x-y', 'plain'] }, d: 3 });
  });

  it('leaves unknown tokens untouched', () => {
    assert.equal(substituteTokens('{{UNKNOWN}}', {}), '{{UNKNOWN}}');
  });

  it('coerces a whole-string numeric token to a JSON number, not a quoted string', () => {
    const input = { seed: '{{SEED}}', weight: '{{WEIGHT}}', fps: '{{FPS}}' };
    const result = substituteTokens(input, { SEED: '123456789', WEIGHT: '0.75', FPS: '24' });
    assert.deepEqual(result, { seed: 123456789, weight: 0.75, fps: 24 });
  });

  it('keeps a whole-string non-numeric token as a string', () => {
    assert.equal(substituteTokens('{{PATH}}', { PATH: '/tmp/character.jpg' }), '/tmp/character.jpg');
  });

  it('does not numeric-coerce a token embedded inside a larger string', () => {
    assert.equal(substituteTokens('frame-{{SEED}}.png', { SEED: '123' }), 'frame-123.png');
  });
});

describe('ComfyUiVideoTransformationProvider', () => {
  let restoreFetch: (() => void) | undefined;
  const originalTimeout = process.env.COMFYUI_TIMEOUT_MS;
  const originalPoll = process.env.COMFYUI_POLL_INTERVAL_MS;
  let workDir: string;

  afterEach(async () => {
    restoreFetch?.();
    restoreFetch = undefined;
    if (originalTimeout === undefined) delete process.env.COMFYUI_TIMEOUT_MS;
    else process.env.COMFYUI_TIMEOUT_MS = originalTimeout;
    if (originalPoll === undefined) delete process.env.COMFYUI_POLL_INTERVAL_MS;
    else process.env.COMFYUI_POLL_INTERVAL_MS = originalPoll;
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it('reports name "comfyui"', () => {
    assert.equal(new ComfyUiVideoTransformationProvider().name, 'comfyui');
  });

  it('throws BACKEND_UNAVAILABLE when ComfyUI cannot be reached', async () => {
    restoreFetch = withFetchQueue([new Error('ECONNREFUSED')]);
    await assert.rejects(
      () => new ComfyUiVideoTransformationProvider().transform(baseTransformInput()),
      (err: unknown) => err instanceof VideoTransformError && err.code === 'BACKEND_UNAVAILABLE',
    );
  });

  it('throws BACKEND_FAILED when ComfyUI rejects the submitted workflow', async () => {
    restoreFetch = withFetchQueue([jsonResponse({ error: 'bad graph' }, { ok: false, status: 400 })]);
    await assert.rejects(
      () => new ComfyUiVideoTransformationProvider().transform(baseTransformInput()),
      (err: unknown) => err instanceof VideoTransformError && err.code === 'BACKEND_FAILED',
    );
  });

  it('throws BACKEND_FAILED when the response reports node_errors', async () => {
    restoreFetch = withFetchQueue([jsonResponse({ prompt_id: 'p1', node_errors: { '5': 'missing checkpoint' } })]);
    await assert.rejects(
      () => new ComfyUiVideoTransformationProvider().transform(baseTransformInput()),
      (err: unknown) => err instanceof VideoTransformError && err.code === 'BACKEND_FAILED',
    );
  });

  it('throws MALFORMED_BACKEND_RESPONSE when /prompt omits prompt_id', async () => {
    restoreFetch = withFetchQueue([jsonResponse({})]);
    await assert.rejects(
      () => new ComfyUiVideoTransformationProvider().transform(baseTransformInput()),
      (err: unknown) => err instanceof VideoTransformError && err.code === 'MALFORMED_BACKEND_RESPONSE',
    );
  });

  it('throws BACKEND_FAILED when the run itself errors out', async () => {
    process.env.COMFYUI_POLL_INTERVAL_MS = '10';
    restoreFetch = withFetchQueue([
      jsonResponse({ prompt_id: 'p1' }),
      jsonResponse({ p1: { status: { status_str: 'error' } } }),
    ]);
    await assert.rejects(
      () => new ComfyUiVideoTransformationProvider().transform(baseTransformInput()),
      (err: unknown) => err instanceof VideoTransformError && err.code === 'BACKEND_FAILED',
    );
  });

  it('throws BACKEND_TIMEOUT when the run never completes within the configured timeout', async () => {
    process.env.COMFYUI_TIMEOUT_MS = '50';
    process.env.COMFYUI_POLL_INTERVAL_MS = '10';
    restoreFetch = withFetchQueue([
      jsonResponse({ prompt_id: 'p1' }),
      () => jsonResponse({}), // history not present yet, and keeps not being present
      () => jsonResponse({}),
      () => jsonResponse({}),
      () => jsonResponse({}),
      () => jsonResponse({}),
      () => jsonResponse({}),
      () => jsonResponse({}),
      () => jsonResponse({}),
    ]);
    await assert.rejects(
      () => new ComfyUiVideoTransformationProvider().transform(baseTransformInput()),
      (err: unknown) => err instanceof VideoTransformError && err.code === 'BACKEND_TIMEOUT',
    );
  });

  it('throws MALFORMED_BACKEND_RESPONSE when a completed run has no recognizable output', async () => {
    process.env.COMFYUI_POLL_INTERVAL_MS = '10';
    workDir = await mkdtemp(join(tmpdir(), 'comfyui-provider-'));
    restoreFetch = withFetchQueue([
      jsonResponse({ prompt_id: 'p1' }),
      jsonResponse({ p1: { status: { completed: true }, outputs: { '16': {} } } }),
    ]);
    await assert.rejects(
      () => new ComfyUiVideoTransformationProvider().transform(baseTransformInput({ workDir })),
      (err: unknown) => err instanceof VideoTransformError && err.code === 'MALFORMED_BACKEND_RESPONSE',
    );
  });

  it('downloads and returns a video-kind output when the run produces one (happy path)', async () => {
    process.env.COMFYUI_POLL_INTERVAL_MS = '10';
    workDir = await mkdtemp(join(tmpdir(), 'comfyui-provider-'));
    const videoBytes = new Uint8Array([1, 2, 3, 4]);
    restoreFetch = withFetchQueue([
      jsonResponse({ prompt_id: 'p1' }),
      jsonResponse({
        p1: {
          status: { completed: true },
          outputs: { '16': { gifs: [{ filename: 'video-transform_00001.mp4', subfolder: '', type: 'output' }] } },
        },
      }),
      binaryResponse(videoBytes),
    ]);

    const output = await new ComfyUiVideoTransformationProvider().transform(baseTransformInput({ workDir }));
    assert.equal(output.kind, 'video');
    if (output.kind !== 'video') return;
    assert.ok(output.path.startsWith(workDir));
  });
});
