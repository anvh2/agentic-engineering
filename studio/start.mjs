import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT ?? 4111);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be 1024–65535');
const studio = resolve(root, '.workdir/studio-dist');
const runtime = resolve(root, '.mastra/output/index.mjs');
const assets = resolve(root, 'apps/control-center/dist');
for (const path of [runtime, resolve(studio, 'index.html'), resolve(assets, 'app.js')]) await access(path);
// `mastra build` without --studio hard-codes `studio: false`; MASTRA_STUDIO_PATH is then ignored
// and the root serves Mastra's welcome page instead of Studio.
if (!(await readFile(runtime, 'utf8')).includes('studio: true'))
  throw new Error('Runtime was built without Studio. Run: MASTRA_TELEMETRY_DISABLED=1 npm run build -- --studio');
// Never take over or terminate an existing server.
await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', () => reject(new Error(`Port ${port} is occupied; stop its owner through the owning session first.`)));
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
const cwd = resolve(root, '.workdir/control-center-runtime');
await mkdir(cwd, { recursive: true });
// An isolated preview of the real Mastra config; no .env or cloud credentials loaded.
// The scheduler database is only read, never copied or constructed by the Gateway.
const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'TERM'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
Object.assign(env, {
  NODE_ENV: 'production', PORT: String(port), MASTRA_HOST: '127.0.0.1',
  MASTRA_TELEMETRY_DISABLED: '1', MASTRA_STUDIO_PATH: studio,
  CONTROL_CENTER_ENABLED: '1', CONTROL_CENTER_ASSETS_DIR: assets,
  CONTROL_CENTER_STUDIO_ORIGIN: `http://127.0.0.1:${port}`,
  AGENTIC_SCHED_DB: process.env.AGENTIC_SCHED_DB ?? resolve(root, '.workdir/scheduler/scheduler.db'),
  TURSO_DATABASE_URL: `file:${resolve(cwd, 'mastra.db')}`,
});
if (process.env.CONTROL_CENTER_CAPACITY_DB) env.CONTROL_CENTER_CAPACITY_DB = process.env.CONTROL_CENTER_CAPACITY_DB;
// Read-only: another checkout's council records (<workdir>/council), e.g. the worktree where a council ran.
if (process.env.CONTROL_CENTER_COUNCIL_WORKDIR) env.CONTROL_CENTER_COUNCIL_WORKDIR = resolve(process.env.CONTROL_CENTER_COUNCIL_WORKDIR);
console.log(`Studio Organization preview: http://127.0.0.1:${port}/organization`);
console.log('Scheduler reads are authoritative; preview Mastra trace storage is isolated and may not contain prior traces.');
const child = spawn(process.execPath, [runtime], { cwd, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { process.exitCode = code ?? 1; });
