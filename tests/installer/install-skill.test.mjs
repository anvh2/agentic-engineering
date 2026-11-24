import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const installer = join(root, 'scripts/install-skill.mjs');
const skill = readFileSync(join(root, 'skills/autonomous-engineering/SKILL.md'), 'utf8');
const temp = () => mkdtempSync(join(tmpdir(), 'ae-skill-install-'));
const run = (target, ...args) => spawnSync(process.execPath, [installer, '--target', target, ...args], { encoding: 'utf8' });

test('installs for Claude and Codex and is idempotent', () => {
  const target = temp();
  try {
    writeFileSync(join(target, 'package.json'), '{"name":"fixture"}');
    const first = run(target);
    assert.equal(first.status, 0, first.stderr);
    const claude = join(target, '.claude/skills/autonomous-engineering/SKILL.md');
    const codex = join(target, '.agents/skills/autonomous-engineering/SKILL.md');
    assert.equal(readFileSync(claude, 'utf8'), skill);
    assert.equal(readFileSync(codex, 'utf8'), skill);
    const second = run(target);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /unchanged/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('does not overwrite a different existing skill', () => {
  const target = temp();
  try {
    writeFileSync(join(target, 'package.json'), '{"name":"fixture"}');
    const directory = join(target, '.agents/skills/autonomous-engineering');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'SKILL.md'), 'user content');
    const result = run(target, '--agents', 'codex');
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(directory, 'SKILL.md'), 'utf8'), 'user content');
    assert.match(result.stderr, /refusing to overwrite/i);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('refuses symlinked skill directories', () => {
  const target = temp();
  const outside = temp();
  try {
    writeFileSync(join(target, 'package.json'), '{"name":"fixture"}');
    symlinkSync(outside, join(target, '.agents'));
    const result = run(target, '--agents', 'codex');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symlink/i);
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
