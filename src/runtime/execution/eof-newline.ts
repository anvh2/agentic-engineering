/**
 * Harness-owned EOF normalization for non-Go files (Go has gofmt). Whole-file `writeFile` edits by a small model
 * routinely drop (or add) the final newline, producing an unrelated one-byte diff (observed: ESHOP-001, JS).
 *
 *  - existing file: the file's original "ends with a newline / does not" state is preserved exactly.
 *  - new (or previously empty) file: a non-empty file must end with exactly the conventional single newline.
 * Only the very end of the file is ever touched, and CRLF files keep CRLF. Content is never otherwise rewritten.
 */
export function preserveEofNewline(original: string | undefined, current: string): string {
  if (current === '') return current;
  const eol = (original ?? '').includes('\r\n') || (!original && current.includes('\r\n')) ? '\r\n' : '\n';
  const endsWithNewline = current.endsWith('\n');

  if (original === undefined || original === '') {
    return endsWithNewline ? current : `${current}${eol}`;
  }
  const originalEndsWithNewline = original.endsWith('\n');
  if (originalEndsWithNewline && !endsWithNewline) return `${current}${eol}`;
  if (!originalEndsWithNewline && endsWithNewline) return current.replace(/\r?\n$/, '');
  return current;
}
