/**
 * One argv policy for `gofmt` wherever a task-supplied or fixture-supplied verification command may run it (lifecycle verification,
 * the integration allow-list, evaluation fixtures). It is CHECK-ONLY: `-l` (list), `-d` (diff), `-s` (simplify, reports with -l/-d)
 * and `-e` (report all errors). `-w` and `-r` would rewrite the tree being verified, so a verifier could change what it then tests.
 * Formatting that is meant to modify files goes through the sandboxed `runGoFmt` worker tool, never through this path.
 */
const CHECK_ONLY_FLAGS: readonly string[] = ['-l', '-d', '-s', '-e'];

/** A repo-relative `.go` file, or a directory (`.`, `./pkg`, `pkg/sub`): no absolute path, no `..`, no unusual characters. */
export function gofmtPathAllowed(p: string): boolean {
  if (p.startsWith('/') || p.split('/').includes('..') || !/^[A-Za-z0-9_.\/-]+$/.test(p)) return false;
  const last = p.split('/').filter(Boolean).at(-1) ?? '';
  return last === '.' || last.endsWith('.go') || !last.includes('.');
}

/** `argv[0]` must be `gofmt`. Returns a reason when the command is refused, otherwise undefined. */
export function gofmtArgvProblem(argv: readonly string[]): string | undefined {
  if (argv[0] !== 'gofmt') return 'not a gofmt command';
  const args = argv.slice(1);
  const flags = args.filter((a) => a.startsWith('-')), paths = args.filter((a) => !a.startsWith('-'));
  if (flags.some((f) => !CHECK_ONLY_FLAGS.includes(f))) return `gofmt flag is not allow-listed (check-only: ${CHECK_ONLY_FLAGS.join(', ')})`;
  if (!paths.length || !paths.every(gofmtPathAllowed)) return 'gofmt needs repo-relative .go files or directories';
  return undefined;
}
