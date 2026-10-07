import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { preserveEofNewline } from './eof-newline.ts';

describe('preserveEofNewline', () => {
  it('restores a final newline the worker dropped (the ESHOP-001 case)', () => {
    assert.equal(preserveEofNewline('a;\n', 'b;'), 'b;\n');
  });
  it('removes a final newline the worker added to a file that never had one', () => {
    assert.equal(preserveEofNewline('a;', 'b;\n'), 'b;');
  });
  it('leaves a file alone when the EOF state already matches', () => {
    assert.equal(preserveEofNewline('a;\n', 'b;\n'), 'b;\n');
    assert.equal(preserveEofNewline('a;', 'b;'), 'b;');
  });
  it('gives a new or previously-empty file a single conventional final newline', () => {
    assert.equal(preserveEofNewline(undefined, 'x;'), 'x;\n');
    assert.equal(preserveEofNewline('', 'x;'), 'x;\n');
    assert.equal(preserveEofNewline('', 'x;\n'), 'x;\n');
  });
  it('keeps CRLF files CRLF', () => {
    assert.equal(preserveEofNewline('a;\r\n', 'b;'), 'b;\r\n');
    assert.equal(preserveEofNewline('a;\r\nb;', 'c;\r\n'), 'c;');
  });
  it('never touches anything but the very end', () => {
    assert.equal(preserveEofNewline('a\n', 'x\n\ny'), 'x\n\ny\n');
    assert.equal(preserveEofNewline('a\n', ''), '');
  });
});
