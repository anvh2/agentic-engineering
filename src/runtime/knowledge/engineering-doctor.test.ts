import { probeOllama } from './engineering-control.ts';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { engineeringStatus } from './engineering-doctor.ts';
test('doctor does not claim evaluated capability without independent evidence',()=>{
 const r=engineeringStatus({entries:[],trials:[],configuredAdapters:['go','js'],hooksEnabled:false});
 assert.equal(r.providersWithEvidence,0);
 assert.ok(r.issues.some(x=>x.code==='no_eval_evidence'));
 assert.ok(r.issues.some(x=>x.code==='no_approved_knowledge'));
});
test('doctor flags unsupported adapter and unchecked active hooks',()=>{
 const r=engineeringStatus({entries:[],trials:[],configuredAdapters:['rust','ts'],hooksEnabled:true});
 assert.ok(r.issues.some(x=>x.code==='unknown_adapter'&&x.level==='error'));
 assert.ok(r.issues.some(x=>x.code==='hooks_unverified'));
});

test('F-25 the Ollama probe never follows a redirect and reports a non-Ollama body instead of throwing', async () => {
  const env = { OLLAMA_BASE_URL: 'http://127.0.0.1:11434', OLLAMA_MODEL: 'qwen3:8b' };
  let seen: RequestInit | undefined;
  const notOllama = (async (_url: unknown, init?: RequestInit) => { seen = init; return new Response('<html>not json</html>', { status: 200 }); }) as typeof fetch;
  const r = await probeOllama(env, notOllama);
  assert.equal(seen?.redirect, 'error', 'a redirect is a failure, never followed');
  assert.equal(r.configured, false);
  assert.match(r.detail, /not Ollama/);
  const redirecting = (async () => { throw new TypeError('redirect mode is set to error'); }) as typeof fetch;
  assert.equal((await probeOllama(env, redirecting)).configured, false);
});
