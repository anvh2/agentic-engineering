import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createAndStartTrellisTask,
  finishTrellisTask,
  hasTrellis,
  readTrellisSpecContext,
} from './trellis-integration.ts';
import { createFixtureRepo, type FixtureRepo } from '../tools/__testing__/fixture-repo.ts';

describe('Trellis integration (a repository with no .trellis setup)', () => {
  let fixture: FixtureRepo;

  before(async () => {
    fixture = await createFixtureRepo();
  });

  after(async () => {
    await fixture.cleanup();
  });

  it('hasTrellis is false', async () => {
    assert.equal(await hasTrellis(fixture.root), false);
  });

  it('readTrellisSpecContext returns undefined', async () => {
    assert.equal(await readTrellisSpecContext(fixture.root), undefined);
  });

  it('createAndStartTrellisTask fails closed (no task.py to run) without throwing', async () => {
    const handle = await createAndStartTrellisTask(fixture.root, 'Scratch task', 'scratch-task');
    assert.equal(handle.started, false);
    assert.equal(handle.taskDir, undefined);
  });

  it('finishTrellisTask does not throw', async () => {
    await assert.doesNotReject(() => finishTrellisTask(fixture.root));
  });
});

describe('Trellis integration (a repository with a .trellis/spec setup)', () => {
  let fixture: FixtureRepo;

  before(async () => {
    fixture = await createFixtureRepo();
    await mkdir(join(fixture.root, '.trellis', 'spec', 'backend'), { recursive: true });
    await mkdir(join(fixture.root, '.trellis', 'scripts'), { recursive: true });
    await writeFile(
      join(fixture.root, '.trellis', 'spec', 'backend', 'index.md'),
      '# Backend Guidelines\n\nUse table-driven tests.\n',
    );
    await writeFile(
      join(fixture.root, '.trellis', 'spec', 'backend', 'testing-guidelines.md'),
      '# Testing\n\nCover edge cases.\n',
    );
    // A minimal stand-in for the real task.py - just enough to prove
    // hasTrellis() only checks for the file's existence, not its content.
    await writeFile(join(fixture.root, '.trellis', 'scripts', 'task.py'), '#!/usr/bin/env python3\n');
  });

  after(async () => {
    await fixture.cleanup();
  });

  it('hasTrellis is true', async () => {
    assert.equal(await hasTrellis(fixture.root), true);
  });

  it('readTrellisSpecContext concatenates every spec markdown file with a relative-path header', async () => {
    const context = await readTrellisSpecContext(fixture.root);
    assert.ok(context);
    assert.deepEqual(
      context!.files.sort(),
      ['.trellis/spec/backend/index.md', '.trellis/spec/backend/testing-guidelines.md'].sort(),
    );
    assert.match(context!.text, /## \.trellis\/spec\/backend\/index\.md/);
    assert.match(context!.text, /Use table-driven tests\./);
    assert.match(context!.text, /## \.trellis\/spec\/backend\/testing-guidelines\.md/);
    assert.match(context!.text, /Cover edge cases\./);
    assert.equal(context!.truncated, false);
  });
});
