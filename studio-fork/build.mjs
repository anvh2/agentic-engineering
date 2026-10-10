import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, access, readdir, symlink, cp, chmod } from 'node:fs/promises';
import { resolve, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pin = JSON.parse(await readFile(new URL('./upstream.json', import.meta.url), 'utf8'));
const work = resolve(root, '.workdir/studio-source');
const source = resolve(work, `mastra-${pin.commit}`);
const patch = resolve(root, 'studio-fork/organization.patch');
const bin = resolve(root, '.workdir/studio-build-bin');
const cache = resolve(root, '.workdir/studio-npm-cache');
const exists = p => access(p).then(() => true, () => false);
function run(command, args, cwd = source, extra = {}) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, CI: 'true', TURBO_TELEMETRY_DISABLED: '1', ...extra } });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.error})`);
}
await mkdir(work, { recursive: true });
if (!await exists(resolve(source, 'package.json'))) {
  const response = await fetch(`https://codeload.github.com/mastra-ai/mastra/tar.gz/${pin.commit}`);
  if (!response.ok) throw new Error(`Source download failed: ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(archive).digest('hex') !== pin.archiveSha256) throw new Error('Upstream archive checksum mismatch');
  const path = resolve(work, `${pin.commit}.tgz`);
  await writeFile(path, archive);
  run('tar', ['-xzf', path, '-C', work], work);
}
// The archive has no .git, so the source would sit inside this worktree's repo (where .workdir/ is ignored)
// and upstream's own .gitignore would not apply. Tailwind v4 source detection then crawls every pnpm
// node_modules tree (~18 GB, killed under memory pressure). Give the source its own repository boundary.
if (!await exists(resolve(source, '.git'))) run('git', ['init', '-q']);
// organization.patch is the feature; upstream-build-fix.patch is a type-only fix (identical JS) that the
// pinned commit needs to pass its own declaration-emit gate with the lockfile's recharts 3.8.1.
const patches = [patch, resolve(root, 'studio-fork/upstream-build-fix.patch')];
for (const file of patches) {
  const check = spawnSync('git', ['apply', '--check', file], { cwd: source, stdio: 'ignore' });
  if (check.status === 0) run('git', ['apply', file]);
  else if (spawnSync('git', ['apply', '--reverse', '--check', file], { cwd: source, stdio: 'ignore' }).status !== 0) throw new Error(`Source differs from ${file}; use a fresh isolated source directory`);
}

// Root runtime dependencies never participate in the upstream build.
run('npm', ['exec', '--cache', cache, '--yes', `--package=pnpm@${pin.pnpm}`, '--', 'pnpm', '--filter', 'mastra-turbo', '--filter', '@internal/playground...', '--filter', '@mastra/agent-builder...', '--filter', '@mastra/server...', 'install', '--frozen-lockfile', '--ignore-scripts', '--config.enableGlobalVirtualStore=false', `--store-dir=${resolve(root, '.workdir/studio-pnpm-store')}`]);

// Some filtered pnpm installs omit executable shims. Resolve declared build tools
// into our own directory, without editing node_modules or generated Studio output.
await mkdir(bin, { recursive: true });
async function linkTools(directory) {
  if (await exists(resolve(directory, 'package.json')) && await exists(resolve(directory, 'node_modules'))) {
    const pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      const dep = resolve(directory, 'node_modules', name);
      if (!await exists(resolve(dep, 'package.json'))) continue;
      const manifest = JSON.parse(await readFile(resolve(dep, 'package.json'), 'utf8'));
      const bins = typeof manifest.bin === 'string' ? { [name.split('/').at(-1)]: manifest.bin } : manifest.bin ?? {};
      for (const [name, target] of Object.entries(bins)) {
        const file = resolve(bin, name);
        if (!await exists(file) && await exists(resolve(dep, target))) await symlink(resolve(dep, target), file);
      }
    }
  }
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory() && !['node_modules', 'dist', '.git', '.workdir', '.turbo'].includes(entry.name)) await linkTools(resolve(directory, entry.name));
}
await linkTools(source);
// Find the pinned npm-exec pnpm package, avoiding reliance on a global pnpm version.
for (const entry of await readdir(resolve(cache, '_npx'))) {
  const cli = resolve(cache, '_npx', entry, 'node_modules/pnpm/bin/pnpm.cjs');
  if (await exists(cli) && !await exists(resolve(bin, 'pnpm'))) {
    const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
    await writeFile(resolve(bin, 'pnpm'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} \"$@\"\n`);
    await chmod(resolve(bin, 'pnpm'), 0o755);
  }
}
// pnpm 11 verifies deps before every `pnpm run`; against a filtered install that check starts an
// unfiltered workspace install (native addons, global store). The filtered install above is the pin.
run(process.execPath, [resolve(source, 'node_modules/turbo/bin/turbo'), 'build', '--filter=@internal/playground', '--concurrency=2', '--env-mode=loose'], source, {
  PATH: `${bin}${delimiter}${process.env.PATH}`,
  pnpm_config_verify_deps_before_run: 'false', npm_config_verify_deps_before_run: 'false',
});
const output = resolve(root, '.workdir/studio-dist');
await cp(resolve(source, 'packages/playground/dist'), output, { recursive: true });
await cp(resolve(source, 'LICENSE.md'), resolve(output, 'UPSTREAM-LICENSE.md'));
await cp(resolve(source, 'ee/LICENSE'), resolve(output, 'UPSTREAM-EE-LICENSE'));
await writeFile(resolve(output, 'organization-build.json'), JSON.stringify({ ...pin, patchSha256: createHash('sha256').update(await readFile(patch)).digest('hex'),
  buildFixSha256: createHash('sha256').update(await readFile(patches[1])).digest('hex') }, null, 2));
console.log(`Pinned Studio built: ${output}`);
