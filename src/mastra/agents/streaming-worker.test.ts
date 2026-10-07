import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asStreamingWorker } from './streaming-worker.ts';

describe('asStreamingWorker', () => {
  it('exposes stream()+getFullOutput() as a generate()-shaped response and forwards options', async () => {
    let seen: unknown;
    const agent = {
      stream: async (_prompt: string, options: unknown) => {
        seen = options;
        return { getFullOutput: async () => ({ text: 'hi', finishReason: 'stop', steps: [{ content: [] }], totalUsage: { inputTokens: 3, outputTokens: 4 }, usage: { inputTokens: 1, outputTokens: 1 } }) };
      },
    };
    const worker = asStreamingWorker(agent as never);
    const res = await worker.generate('p', { marker: 1 });
    assert.deepEqual(seen, { marker: 1 });
    assert.equal(res.text, 'hi');
    assert.equal(res.steps?.length, 1);
    assert.equal(res.usage?.outputTokens, 4);
  });

  it('propagates stream failures so the runner can classify them as runtime failures', async () => {
    const agent = { stream: async () => { throw new Error('boom'); } };
    await assert.rejects(asStreamingWorker(agent as never).generate('p', {}), /boom/);
  });
});
