// Real coding task against eshop (JS/Node, Jest + Prettier) - the second
// target repository this pipeline has run against, after Step 16's original
// Go run on vus-metadata-v2. Exercises the same pipeline end to end,
// including the newly-added JS ecosystem support (runPrettier/runJestTest,
// ecosystem auto-detection in codingTaskWorkflow) and a freshly-bootstrapped
// Trellis spec (.trellis/spec/library/) for this repository.
import { runRealCodingTask } from './lib/run-real-coding-task.ts';

const TASK = `In this repository, add unit tests for the buildFilterFromUrl function in src/library/util/buildFilterFromUrl.js.

buildFilterFromUrl(query) converts a parsed URL query object into an array of filter descriptors ({ key, operation, value }) for building a database query. Read the function's actual source carefully before writing any test - it has several distinct branches and at least one real edge case around how sortBy/sortOrder/page/limit are handled (they are processed both as generic query keys AND with dedicated logic afterward), so derive every expected value from the code itself, not from assumption.

This package already has existing unit tests in the same style you must follow: src/library/util/tests/unit/util.get.test.js (and its siblings in that same directory - util.assign.test.js, util.merge.test.js, util.getConfig.test.js).

Steps:
1. Read src/library/util/buildFilterFromUrl.js completely.
2. Read src/library/util/tests/unit/util.get.test.js to see the exact conventions: file location (a sibling tests/unit/ directory, not co-located with the source), describe/it structure, require() style, and expect(...).toEqual(...) assertion style.
3. Create src/library/util/tests/unit/util.buildFilterFromUrl.test.js with tests covering at minimum: an empty/falsy query (expect []), an array-valued filter with valid numeric values (expect an IN operation), an array-valued filter where none of the values parse as numbers (check what the function actually does), a plain string filter value with no '%' (expect an '=' operation), a string filter value starting or ending with '%' (expect a LIKE operation), and the sortBy/sortOrder/page/limit handling (verify against the function's real behavior for these keys, including whether they appear more than once in the output when present in the input).
4. Run npx jest on the new test file and fix any failures - do not assume your first attempt at expected values is correct; trust the actual test output over your own prediction.`;

await runRealCodingTask({
  label: 'ESHOP',
  task: TASK,
  trellisTaskSlug: 'eshop-build-filter-from-url-tests',
  trellisTaskTitle: 'Eshop: buildFilterFromUrl tests',
});
