import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { runSandboxedCommand } from './sandbox.ts';

/**
 * Verifier sandbox parity (M8.7B). The verifier runs worker-written code (`go test`, `gofmt`, `npx jest`) as the user. These tests plant
 * SYNTHETIC secrets and unrelated files where real ones live (the real home directory, another task's worktree and artifacts, an oracle
 * directory, the shared temp directories) and prove that code run through `runSandboxedCommand` cannot read them by any route, cannot write
 * anywhere but its root and its private temp dir, and still builds, tests and formats Go. Nothing real is read: markers are random strings
 * this test wrote.
 */

const darwin = process.platform === 'darwin';
const mark = (name: string) => `M87B-${name}-${Math.random().toString(36).slice(2, 10)}`;

interface Planted {
  name: string;
  path: string;
  marker: string;
}

const HOME_SECRETS: Record<string, string> = {
  'ssh-private-key': '.ssh/id_ed25519',
  'aws-credentials': '.aws/credentials',
  'gcloud-adc': '.config/gcloud/application_default_credentials.json',
  'github-cli-token': '.config/gh/hosts.yml',
  netrc: '.netrc',
  'npm-token': '.npmrc',
  'git-credentials': '.git-credentials',
  'docker-config': '.docker/config.json',
  kubeconfig: '.kube/config',
  'shell-history': '.zsh_history',
  'keychain-file': 'Library/Keychains/login.keychain-db',
  'codex-auth': '.codex/auth.json',
  // in no credential list at all: only an allow-list keeps these out
  'unlisted-notes': 'notes/passwords.txt',
  'dotenv-elsewhere': 'other-project/.env',
  'other-task-worktree-source': 'projects/batch/other-task/secret.go',
  'other-task-artifact': 'artifacts/other-task/attempts.json',
  'oracle-file': 'oracle/acceptance_test.go',
};

describe('verifier sandbox: read allow-list (synthetic credentials and private files)', { skip: !darwin && 'macOS only', timeout: 600_000 }, () => {
  let base: string;
  let synth: string;
  let root: string;
  let outsideLink: string;
  const planted: Planted[] = [];
  let foreignTmp: Planted;
  let foreignSlashTmp: Planted;
  const cleanup: string[] = [];

  const run = (command: string, args: string[], extra: { readAllow?: string[]; denyRead?: string[]; timeoutMs?: number } = {}) => runSandboxedCommand(command, args, { cwd: root, root, timeoutMs: extra.timeoutMs ?? 120_000, readAllow: extra.readAllow, denyRead: extra.denyRead });

  before(() => {
    const home = realpathSync(homedir());
    base = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-iso-')));
    cleanup.push(base);
    // a hidden directory inside the REAL home directory: where a credential would be, never under a temp directory
    synth = join(home, `.agentic-vcanary-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(synth);
    cleanup.push(synth);
    for (const [name, rel] of Object.entries(HOME_SECRETS)) {
      const path = join(synth, rel);
      mkdirSync(dirname(path), { recursive: true });
      const marker = mark(name.replace(/[^a-z]/g, ''));
      writeFileSync(path, `${marker}\n`);
      planted.push({ name, path, marker });
    }
    const tmpSecret = (dir: string, name: string): Planted => {
      const d = join(dir, `agentic-vcanary-foreign-${Math.random().toString(36).slice(2, 8)}`);
      mkdirSync(d, { recursive: true });
      cleanup.push(d);
      const marker = mark(name);
      writeFileSync(join(d, 'secret.txt'), `${marker}\n`);
      return { name, path: join(d, 'secret.txt'), marker };
    };
    foreignTmp = tmpSecret(realpathSync(tmpdir()), 'foreign-tmpdir-file');
    foreignSlashTmp = tmpSecret(realpathSync('/tmp'), 'foreign-slash-tmp-file');
    planted.push(foreignTmp, foreignSlashTmp);
    root = join(base, 'root');
    mkdirSync(root);
    outsideLink = join(root, 'link-to-ssh');
    symlinkSync(planted[0].path, outsideLink); // a symlink the WORKER could have left in its worktree
  });
  after(() => {
    for (const p of cleanup) rmSync(p, { recursive: true, force: true });
  });

  it('control: the planted files really are readable by the user (so a blocked read below means the sandbox, not a bad path)', () => {
    for (const p of planted) assert.equal(readFileSync(p.path, 'utf8').trim(), p.marker, p.name);
  });

  it('direct reads of every planted file, and of its directory, are refused', async () => {
    const script = planted.map((p) => `if grep -q '${p.marker}' '${p.path}' 2>/dev/null; then echo "LEAK ${p.name}"; fi; if [ -n "$(ls '${dirname(p.path)}' 2>/dev/null)" ]; then echo "LISTING ${p.name}"; fi`).join('\n');
    const r = await run('/bin/sh', ['-c', `${script}\necho done`]);
    assert.match(r.stdout, /done/);
    assert.doesNotMatch(r.stdout, /LEAK|LISTING/, r.stdout);
    for (const p of planted) assert.doesNotMatch(`${r.stdout}${r.stderr}`, new RegExp(p.marker));
  });

  it('path traversal, symlinks (pre-existing and created by the command), hard links, copies, moves and archives of a secret all fail', async () => {
    const target = planted[0];
    const unlisted = planted.find((p) => p.name === 'unlisted-notes')!;
    const routes = [
      `grep -q '${target.marker}' '${relative(root, target.path)}'`, // relative traversal
      `grep -q '${target.marker}' ./link-to-ssh`, // symlink left in the worktree
      `ln -s '${unlisted.path}' ./sl && grep -q '${unlisted.marker}' ./sl`, // symlink made now
      `ln -s '${dirname(unlisted.path)}' ./sd && grep -q '${unlisted.marker}' ./sd/passwords.txt`, // directory symlink
      `ln '${unlisted.path}' ./hl && grep -q '${unlisted.marker}' ./hl`, // hard link
      `cp '${unlisted.path}' ./cp1 && grep -q '${unlisted.marker}' ./cp1`,
      `mv '${unlisted.path}' ./mv1 && grep -q '${unlisted.marker}' ./mv1`,
      `tar cf t.tar -C '${dirname(unlisted.path)}' . && grep -q '${unlisted.marker}' t.tar`,
      `find '${synth}' -type f | grep -q .`,
      `dd if='${unlisted.path}' 2>/dev/null | grep -q '${unlisted.marker}'`,
      `awk '{print}' '${unlisted.path}' | grep -q '${unlisted.marker}'`,
      `sed -n p '${unlisted.path}' | grep -q '${unlisted.marker}'`,
      `/usr/bin/xxd '${unlisted.path}' >/dev/null 2>&1 && /usr/bin/xxd -p '${unlisted.path}' | grep -q .`,
      `ruby --disable-gems -e 'print File.read("${unlisted.path}")' 2>/dev/null | grep -q '${unlisted.marker}'`,
      `perl -e 'open(F,"<${unlisted.path}") or exit 1; print <F>' 2>/dev/null | grep -q '${unlisted.marker}'`,
      `sqlite3 '${unlisted.path}' '.dump' 2>/dev/null | grep -q '${unlisted.marker}'`,
    ];
    const r = await run('/bin/sh', ['-c', routes.map((route, i) => `if ${route}; then echo "LEAK route ${i}"; fi`).join('\n') + '\necho done']);
    assert.match(r.stdout, /done/);
    assert.doesNotMatch(r.stdout, /LEAK/, `${r.stdout}\n${r.stderr}`);
    assert.equal(readFileSync(unlisted.path, 'utf8').trim(), unlisted.marker, 'the file was not moved or altered');
    for (const p of planted) assert.ok(existsSync(p.path), `${p.name} still exists`);
  });

  it('worker-style Go test code that reads, walks and exfiltrates cannot reach any planted file, and sees a built environment', async () => {
    const goRoot = join(root, 'gocode');
    mkdirSync(goRoot);
    const paths = planted.map((p) => JSON.stringify(p.path));
    writeFileSync(join(goRoot, 'go.mod'), 'module probe\n\ngo 1.22\n');
    writeFileSync(
      join(goRoot, 'probe_test.go'),
      `package probe

import (
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestProbe(t *testing.T) {
	for _, p := range []string{${paths.join(', ')}} {
		if b, err := os.ReadFile(p); err == nil {
			fmt.Printf("LEAK read %q\\n", string(b))
		}
		if out, err := exec.Command("/bin/cat", p).Output(); err == nil {
			fmt.Printf("LEAK cat %q\\n", string(out))
		}
	}
	// a directory walk of the whole home directory finds nothing readable
	home := ${JSON.stringify(realpathSync(homedir()))}
	n := 0
	filepath.WalkDir(home, func(path string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.Contains(path, "agentic-vcanary") {
			n++
		}
		return nil
	})
	fmt.Printf("walk-found=%d\\n", n)
	if ents, err := os.ReadDir(home); err == nil {
		fmt.Printf("LEAK home listing %d\\n", len(ents))
	}
	// what the code can see of the world it runs in
	env := strings.Join(os.Environ(), "\\n")
	fmt.Printf("env-has-real-home=%v\\n", strings.Contains(env, home))
	fmt.Printf("env-user=%q\\n", os.Getenv("USER"))
	fmt.Printf("env-logname=%q\\n", os.Getenv("LOGNAME"))
	fmt.Printf("env-names=%d\\n", len(os.Environ()))
	for _, kv := range os.Environ() {
		if strings.Contains(strings.ToUpper(kv), "TOKEN") || strings.Contains(strings.ToUpper(kv), "SECRET") || strings.Contains(strings.ToUpper(kv), "PASSWORD") {
			fmt.Printf("LEAK env %s\\n", kv)
		}
	}
}
`,
    );
    const env = { M87B_SYNTH_API_TOKEN: 'M87B-ENV-TOKEN', M87B_SYNTH_PASSWORD: 'M87B-ENV-PASSWORD', USER: process.env.USER, LOGNAME: process.env.LOGNAME };
    const before = { ...process.env };
    Object.assign(process.env, { M87B_SYNTH_API_TOKEN: env.M87B_SYNTH_API_TOKEN, M87B_SYNTH_PASSWORD: env.M87B_SYNTH_PASSWORD });
    try {
      const r = await runSandboxedCommand('go', ['test', '-count=1', '-v', '.'], { cwd: goRoot, root, timeoutMs: 300_000 });
      assert.equal(r.exitCode, 0, `${r.stdout}${r.stderr}`);
      const out = `${r.stdout}${r.stderr}`;
      assert.doesNotMatch(out, /LEAK/, out);
      for (const p of planted) assert.doesNotMatch(out, new RegExp(p.marker));
      assert.match(out, /walk-found=0/, 'a walk of the home directory found none of the planted files');
      assert.match(out, /env-has-real-home=false/, 'HOME is the private temp dir, not the real home');
      assert.match(out, /env-user=""/, 'the user name is not passed');
      assert.match(out, /env-logname=""/);
      assert.doesNotMatch(out, /M87B-ENV-/, 'secrets of the runtime process never reach the code');
    } finally {
      for (const k of ['M87B_SYNTH_API_TOKEN', 'M87B_SYNTH_PASSWORD']) if (before[k] === undefined) delete process.env[k];
    }
  });

  it('writes are confined to the root and the private temp dir: every other target, including via symlinks, is refused', async () => {
    const sibling = join(base, 'sibling-task');
    mkdirSync(sibling);
    const victim = join(sibling, 'victim.txt');
    writeFileSync(victim, 'original\n');
    const homeTarget = join(synth, 'written-by-worker.txt');
    const slashTmpTarget = join(realpathSync('/tmp'), `agentic-vcanary-write-${Math.random().toString(36).slice(2, 8)}`);
    cleanup.push(slashTmpTarget);
    const attempts = [
      `echo x > '${homeTarget}'`,
      `echo x > '${slashTmpTarget}'`,
      `echo x > '${victim}'`,
      `echo x >> '${victim}'`,
      `ln -s '${victim}' ./vl && echo x > ./vl`,
      `ln '${victim}' ./vh`,
      `mv '${victim}' ./moved`,
      `rm '${victim}'`,
      `echo x > '${join(root, '.git', 'hooks-probe')}'`,
      `mkdir -p '${join(root, '.git')}' && echo x > '${join(root, '.git', 'HEAD')}'`,
      `echo x > '${join(realpathSync(homedir()), `.agentic-vcanary-home-write-${Math.random().toString(36).slice(2, 6)}`)}'`,
    ];
    const r = await run('/bin/sh', ['-c', `${attempts.map((a, i) => `if ${a} 2>/dev/null; then echo "WROTE ${i}"; fi`).join('\n')}\necho inside > ./inside.txt && echo inside-ok`]);
    assert.match(r.stdout, /inside-ok/, 'writing inside the root works');
    assert.doesNotMatch(r.stdout, /WROTE/, r.stdout);
    assert.equal(readFileSync(victim, 'utf8'), 'original\n');
    assert.equal(existsSync(homeTarget), false);
    assert.equal(existsSync(slashTmpTarget), false);
    assert.equal(existsSync(join(root, '.git', 'HEAD')), false, 'the root .git stays protected');
  });

  it('non-file channels are closed: network, pasteboard, Keychain, process list, ssh-agent, preferences', async () => {
    const sock = process.env.SSH_AUTH_SOCK ?? '';
    // a real loopback service (the Mastra API and Ollama listen there): reachable unsandboxed, must not be from inside
    const listener = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const direct = await fetch(`http://127.0.0.1:${(listener.address() as { port: number }).port}/`).then((r) => r.status);
    assert.equal(direct, 200, 'control: the listener works');
    const script = [
      `if [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' https://example.com 2>/dev/null)" = 200 ]; then echo "OPEN internet"; fi`,
      `if [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:${(listener.address() as { port: number }).port}/ 2>/dev/null)" = 200 ]; then echo "OPEN loopback"; fi`,
      `if pbpaste >/dev/null 2>&1; then echo "OPEN pasteboard"; fi`,
      `out=$(security find-generic-password -s m87b-nonexistent 2>&1); if echo "$out" | grep -q 'could not be found' && ! echo "$out" | grep -q 'not valid'; then echo "OPEN keychain"; fi`,
      `if [ "$(ps -ax 2>/dev/null | wc -l)" -gt 5 ]; then echo "OPEN process list"; fi`,
      sock ? `if SSH_AUTH_SOCK='${sock}' ssh-add -l 2>&1 | grep -qE 'no identities|SHA256'; then echo "OPEN ssh-agent"; fi` : 'true',
      `if defaults read NSGlobalDomain AppleLanguages >/dev/null 2>&1; then echo "OPEN preferences"; fi`,
      'echo done',
    ].join('\n');
    try {
      const r = await run('/bin/sh', ['-c', script]);
      assert.match(r.stdout, /done/);
      assert.doesNotMatch(r.stdout, /OPEN/, r.stdout);
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });

  it('the channel probes are capable: unsandboxed, the same calls succeed (so "blocked" above is the sandbox)', () => {
    const sh = (cmd: string) => {
      try {
        return execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        return String((err as { stdout?: string }).stdout ?? '');
      }
    };
    assert.ok(Number(sh('ps -ax 2>/dev/null | wc -l').trim()) > 5, 'process listing works unsandboxed');
    assert.match(sh('security find-generic-password -s m87b-nonexistent 2>&1'), /could not be found/);
    assert.equal(execFileSync('/bin/sh', ['-c', 'pbpaste >/dev/null 2>&1; echo $?'], { encoding: 'utf8' }).trim(), '0');
  });

  it('Go build, test, vet, gofmt and a main-package build work, with a worktree whose git directory is not readable', async () => {
    const proj = join(root, 'compat');
    mkdirSync(join(proj, 'cmd', 'app'), { recursive: true });
    mkdirSync(join(proj, 'dep'), { recursive: true });
    writeFileSync(join(proj, 'go.mod'), 'module compat\n\ngo 1.22\n\nrequire example.com/dep v0.0.0\n\nreplace example.com/dep => ./dep\n');
    writeFileSync(join(proj, 'dep', 'go.mod'), 'module example.com/dep\n\ngo 1.22\n');
    writeFileSync(join(proj, 'dep', 'dep.go'), 'package dep\n\nfunc Two() int { return 2 }\n');
    writeFileSync(join(proj, 'a.go'), 'package compat\n\nimport "example.com/dep"\n\nfunc F() int { return dep.Two() - 1 }\n');
    writeFileSync(join(proj, 'a_test.go'), 'package compat\n\nimport "testing"\n\nfunc TestF(t *testing.T) {\n\tif F() != 1 {\n\t\tt.Fatal(F())\n\t}\n}\n');
    writeFileSync(join(proj, 'cmd', 'app', 'main.go'), 'package main\n\nimport (\n\t"fmt"\n\t"compat"\n)\n\nfunc main() { fmt.Println(compat.F()) }\n');
    // a worktree's `.git` is a FILE pointing at a directory outside it: not readable here, so VCS stamping must not be attempted
    writeFileSync(join(proj, '.git'), `gitdir: ${join(synth, 'no-such-gitdir')}\n`);
    const go = (args: string[]) => runSandboxedCommand('go', args, { cwd: proj, root: proj, timeoutMs: 300_000 });
    for (const args of [['version'], ['build', './...'], ['test', '-count=1', './...'], ['vet', './...']]) {
      const r = await go(args);
      assert.equal(r.exitCode, 0, `go ${args.join(' ')}: ${r.stdout}${r.stderr}`);
    }
    const fmt = await runSandboxedCommand('gofmt', ['-l', '.'], { cwd: proj, root: proj, timeoutMs: 60_000 });
    assert.equal(fmt.exitCode, 0, fmt.stderr);
    const bad = join(proj, 'ugly.go');
    writeFileSync(bad, 'package compat\nfunc  G( ) int {return 1}\n');
    const rewrite = await runSandboxedCommand('gofmt', ['-w', 'ugly.go'], { cwd: proj, root: proj, timeoutMs: 60_000 });
    assert.equal(rewrite.exitCode, 0, rewrite.stderr);
    assert.match(readFileSync(bad, 'utf8'), /func G\(\) int \{ return 1 \}/, 'gofmt rewrote the file inside the root');
    const mod = await go(['env', 'GOMODCACHE']);
    assert.equal(mod.exitCode, 0);
    assert.ok(mod.stdout.trim().startsWith('/'), `the module cache is a fixed absolute path: ${mod.stdout}`);
  });

  it('a dependency resolved offline from the Go module cache builds and tests, through a private alias that does not reveal the home path', async () => {
    const modcache = execFileSync('go', ['env', 'GOMODCACHE'], { encoding: 'utf8' }).trim();
    if (!existsSync(join(modcache, 'golang.org', 'x', 'arch@v0.18.0'))) return; // no suitable module on this machine: nothing to prove
    const proj = join(root, 'withdep');
    mkdirSync(join(proj, 'p'), { recursive: true });
    writeFileSync(join(proj, 'go.mod'), 'module withdep\n\ngo 1.22\n\nrequire golang.org/x/arch v0.18.0\n');
    writeFileSync(join(proj, 'p', 'p.go'), 'package p\n\nimport "golang.org/x/arch/arm64/arm64asm"\n\nfunc Name() string { return arm64asm.X0.String() }\n');
    writeFileSync(join(proj, 'p', 'p_test.go'), 'package p\n\nimport "testing"\n\nfunc TestName(t *testing.T) {\n\tif Name() == "" {\n\t\tt.Fatal("empty")\n\t}\n}\n');
    execFileSync('go', ['mod', 'tidy'], { cwd: proj, env: { ...process.env, GOFLAGS: '-mod=mod', GOPROXY: 'off', GONOSUMDB: '*', GOTOOLCHAIN: 'local' }, stdio: 'pipe' });
    for (const args of [['build', './...'], ['test', '-count=1', './...'], ['vet', './...']]) {
      const r = await runSandboxedCommand('go', args, { cwd: proj, root: proj, timeoutMs: 300_000 });
      assert.equal(r.exitCode, 0, `go ${args.join(' ')}: ${r.stdout}${r.stderr}`);
    }
    const env = await runSandboxedCommand('go', ['env', 'GOMODCACHE'], { cwd: proj, root: proj, timeoutMs: 60_000 });
    assert.doesNotMatch(env.stdout, new RegExp(realpathSync(homedir()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the alias, not the real path');
    // the cache is readable as a module source tree, but its neighbours under the home directory are not
    const neighbour = await runSandboxedCommand('/bin/ls', [dirname(dirname(modcache))], { cwd: proj, root: proj, timeoutMs: 20_000 });
    assert.notEqual(neighbour.exitCode, 0, 'the parent of the module cache (GOPATH, with src/) is not readable');
  });

  it('an explicit readAllow for a dependency directory outside the worktree works; the same path stays closed without it', async () => {
    const deps = join(base, 'linked-deps');
    mkdirSync(deps);
    writeFileSync(join(deps, 'lib.txt'), 'dependency-content\n');
    const closed = await run('/bin/cat', [join(deps, 'lib.txt')]);
    assert.notEqual(closed.exitCode, 0);
    const opened = await run('/bin/cat', [join(deps, 'lib.txt')], { readAllow: [deps] });
    assert.match(opened.stdout, /dependency-content/);
    // the home directory and system roots can never be granted
    for (const bad of [realpathSync(homedir()), '/Users', '/', '/usr', synth.replace(/\/[^/]+$/, '')]) {
      const refused = await run('/bin/echo', ['ran'], { readAllow: [bad] });
      assert.equal(refused.sandboxUnavailable, true, bad);
      assert.doesNotMatch(refused.stdout, /ran/);
    }
  });

  describe('operator-supplied read paths: canonical paths and symlink escapes', () => {
    const refusedFor = async (path: string, viaEnv = false) => {
      if (viaEnv) process.env.AGENTIC_SANDBOX_READ_ALLOW = path;
      try {
        return await run('/bin/echo', ['ran'], viaEnv ? {} : { readAllow: [path] });
      } finally {
        delete process.env.AGENTIC_SANDBOX_READ_ALLOW;
      }
    };
    const assertRefused = (r: Awaited<ReturnType<typeof refusedFor>>, what: string) => {
      assert.equal(r.sandboxUnavailable, true, `${what}: refused`);
      assert.doesNotMatch(r.stdout, /ran/, `${what}: the command did not run`);
    };

    it('a path is judged by where it RESOLVES: a symlink to the home directory, or `..` segments that reach it, are refused', async () => {
      const home = realpathSync(homedir());
      const toHome = join(base, 'alias-to-home');
      symlinkSync(home, toHome);
      assertRefused(await refusedFor(toHome), 'symlink to the home directory');
      assertRefused(await refusedFor(toHome, true), 'symlink to the home directory, via AGENTIC_SANDBOX_READ_ALLOW');
      const viaDots = `${base}/${relative(base, home)}`;
      assert.ok(viaDots.includes('/../'), `the path really contains .. segments: ${viaDots}`);
      assertRefused(await refusedFor(viaDots), '`..` segments that resolve to the home directory');
      assertRefused(await refusedFor(`${home}/Documents/..`), '`..` segment that climbs back to the home directory');
      const toRoot = join(base, 'alias-to-usr');
      symlinkSync('/usr', toRoot);
      assertRefused(await refusedFor(toRoot), 'symlink to a system root');
      const toParent = join(base, 'alias-to-users');
      symlinkSync(dirname(home), toParent);
      assertRefused(await refusedFor(toParent), 'symlink to the directory ABOVE the home directory');
    });

    it('a symlink given as the allowed path grants its target, not the link: reading through either name works, a sibling of the target does not', async () => {
      const deps = join(base, 'canon-deps');
      const sibling = join(base, 'canon-sibling');
      mkdirSync(deps);
      mkdirSync(sibling);
      writeFileSync(join(deps, 'lib.txt'), 'granted\n');
      writeFileSync(join(sibling, 'other.txt'), 'not-granted\n');
      const alias = join(base, 'canon-alias');
      symlinkSync(deps, alias);
      const r = await run('/bin/sh', ['-c', `cat '${alias}/lib.txt'; cat '${deps}/lib.txt'; cat '${sibling}/other.txt' 2>&1; echo done`], { readAllow: [alias] });
      assert.equal((r.stdout.match(/granted/g) ?? []).length - (r.stdout.match(/not-granted/g) ?? []).length * 2, 2, `both names of the allowed directory read: ${r.stdout}`);
      assert.doesNotMatch(r.stdout.replace(/not-granted\s*\n?(?=.*done)/, ''), /^not-granted$/m);
      assert.ok(!/^not-granted$/m.test(r.stdout), 'the sibling directory stayed closed');
    });

    it('a symlink INSIDE an allowed directory that points at a secret does not open the secret', async () => {
      const deps = join(base, 'escape-deps');
      mkdirSync(deps);
      const secret = planted.find((p) => p.name === 'unlisted-notes')!;
      symlinkSync(secret.path, join(deps, 'to-notes'));
      symlinkSync(dirname(secret.path), join(deps, 'to-notes-dir'));
      writeFileSync(join(deps, 'ok.txt'), 'fine\n');
      const r = await run('/bin/sh', ['-c', `cat '${deps}/ok.txt'; cat '${deps}/to-notes' 2>/dev/null; cat '${deps}/to-notes-dir/passwords.txt' 2>/dev/null; echo done`], { readAllow: [deps] });
      assert.match(r.stdout, /fine/);
      assert.doesNotMatch(r.stdout, new RegExp(secret.marker));
    });

    it('a symlink the WORKER leaves in the worktree, `node_modules` included, never grants anything, even next to an allowed dependency path', async () => {
      const jsRoot = join(base, 'js-root');
      const trusted = join(base, 'trusted-node-modules');
      mkdirSync(join(jsRoot, 'src'), { recursive: true });
      mkdirSync(trusted);
      writeFileSync(join(trusted, 'dep.txt'), 'trusted-dependency\n');
      const secret = planted.find((p) => p.name === 'unlisted-notes')!;
      const runIn = (script: string, readAllow?: string[]) => runSandboxedCommand('/bin/sh', ['-c', script], { cwd: jsRoot, root: jsRoot, timeoutMs: 30_000, readAllow });
      // the worker points node_modules at a directory the operator did NOT allow
      symlinkSync(dirname(secret.path), join(jsRoot, 'node_modules'));
      const blocked = await runIn('cat node_modules/passwords.txt 2>&1; echo done', [trusted]);
      assert.doesNotMatch(blocked.stdout, new RegExp(secret.marker), 'a worktree symlink grants nothing by itself');
      // and the trusted, operator-allowed directory is still reachable by its own path
      const allowed = await runIn(`cat '${trusted}/dep.txt'`, [trusted]);
      assert.match(allowed.stdout, /trusted-dependency/);
      // without the operator's allow, the same trusted directory is closed: linked JS dependencies fail closed
      const closed = await runIn(`cat '${trusted}/dep.txt' 2>&1`);
      assert.doesNotMatch(closed.stdout, /trusted-dependency/);
    });

    it('relative paths, quotes and control characters are refused outright', async () => {
      for (const bad of ['relative/dir', '/ok"quote', '/a\\b', '/bad\nnewline', '']) {
        if (bad === '') continue; // an empty AGENTIC_SANDBOX_READ_ALLOW means "none"
        assertRefused(await refusedFor(bad), JSON.stringify(bad));
      }
    });
  });
});
