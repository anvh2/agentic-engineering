// Step 16 - Autonomous Real Coding (original run: vus-metadata-v2 / Go).
//
// Kept as a historical, reproducible record of the first real run. The
// shared orchestration now lives in scripts/lib/run-real-coding-task.ts,
// since scripts/eshop-real-coding-task.ts needed the exact same pipeline
// against a second, differently-shaped repository (JS, not Go).
import { runRealCodingTask } from './lib/run-real-coding-task.ts';

const TASK = `In this repository, add unit tests for the SanitizeBodyForLog function in pkg/utils/http.go (package "utils").

SanitizeBodyForLog(contentType string, body []byte) string returns a log-safe string for an HTTP body: for a non-text content type (not containing "json", "text/plain", or "xml", case-insensitively) it returns a placeholder like "<N bytes, content-type=%q, not logged>" instead of the body; for a text-like content type it returns the body as a string, truncated with a "...(truncated)" suffix if it exceeds maxLoggedBodyBytes (2000) bytes.

This package already has existing test files (pkg/utils/string_test.go, pkg/utils/time_test.go) - follow the same table-driven testing style and conventions used there.

Steps:
1. Read pkg/utils/http.go and an existing test file (e.g. pkg/utils/string_test.go) to see current conventions.
2. Create pkg/utils/http_test.go with table-driven tests for SanitizeBodyForLog covering at least: a JSON content type under the limit, a text/plain content type under the limit, an xml content type, a non-text content type (e.g. "application/octet-stream"), and a text body that exceeds maxLoggedBodyBytes (verify truncation and the suffix).
3. Format the new file.
4. Run the package's tests and fix any failures.`;

await runRealCodingTask({
  label: 'STEP 16',
  task: TASK,
  trellisTaskSlug: 'step16-sanitize-body-for-log-tests',
  trellisTaskTitle: 'Step 16: SanitizeBodyForLog tests',
});
