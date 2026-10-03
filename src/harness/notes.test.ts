import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VALID_NOTES } from './__testing__/fixture.ts';
import { MAX_SECTION_CHARS, notesTemplate, parseNotes, pathCandidates } from './notes.ts';

describe('parseNotes', () => {
  it('accepts all eight sections and normalizes empty optional ones to "none"', () => {
    const result = parseNotes(VALID_NOTES.replace('## Attempts\nnone', '## Attempts\n'));
    assert.ok('notes' in result);
    assert.equal(result.notes.goal, 'Add the widget module.');
    assert.equal(result.notes.attempts, 'none');
    assert.equal(result.notes.questions, 'none');
  });

  it('the template has every required heading', () => {
    const result = parseNotes(notesTemplate());
    assert.ok('notes' in result, JSON.stringify(result));
  });

  it('rejects missing, empty-required, unknown, duplicate and oversized sections, listing every problem', () => {
    const bad = VALID_NOTES.replace('## Goal\nAdd the widget module.', '## Goal\nnone')
      .replace(/## Blockers\nnone\n/, '')
      .concat('## Mood\nfine\n## Why\nagain\n')
      .replace('Created src/widget.js.', 'x'.repeat(MAX_SECTION_CHARS + 1));
    const result = parseNotes(bad);
    assert.ok('errors' in result);
    const text = result.errors.join('\n');
    assert.match(text, /"## Goal" must not be empty/);
    assert.match(text, /Missing section "## Blockers"/);
    assert.match(text, /Unknown section "## Mood"/);
    assert.match(text, /Duplicate section "## Why"/);
    assert.match(text, /"## Changed" is \d+ chars/);
  });
});

describe('pathCandidates', () => {
  it('extracts paths and filenames, ignoring URLs, flags and plain prose', () => {
    const found = pathCandidates('Edited `src/a.js:12`, see (tools/x/) and package.json. https://x.io/a.js --flag pass/fail ok.');
    assert.deepEqual(found.sort(), ['package.json', 'pass/fail', 'src/a.js', 'tools/x/'].sort());
  });
});
