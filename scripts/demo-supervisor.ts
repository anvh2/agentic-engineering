import { planCodingTask } from '../src/mastra/supervisor/claude-supervisor.ts';
import { codingTaskWorkflow } from '../src/mastra/workflows/coding-task-workflow.ts';

const repository = process.env.TARGET_REPOSITORY;

const userRequest = repository
  ? `Write unit tests for an appropriate function in this repository.

First inspect the repository and identify a good candidate.

Do not modify any files yet.

Explain:
1. Which function you selected.
2. Why it is a good unit-test candidate.
3. Existing test patterns in the repository.
4. What test cases should be added.
5. Which files would eventually need to change.`
  : `Write unit tests for this Go function:

func Add(a, b int) int {
	return a + b
}

Requirements:
- Use Go's standard testing package.
- Cover positive numbers.
- Cover zero values.
- Cover negative numbers.`;

if (!repository) {
  console.log('TARGET_REPOSITORY is not set - falling back to the text-only sample task (no repository access).\n');
}

console.log('Asking the Claude supervisor to plan the task...\n');

const delegation = await planCodingTask(userRequest, { repository });

console.log('Supervisor delegation:');
console.log(JSON.stringify(delegation, null, 2));

console.log(`\nRunning codingTaskWorkflow via ${process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'} ...\n`);

const run = await codingTaskWorkflow.createRun();
const result = await run.start({ inputData: delegation });

if (result.status === 'success') {
  console.log('codingWorker result:\n');
  console.log(result.result.result);
} else if (result.status === 'failed') {
  console.error('Workflow failed:', result.error);
  process.exitCode = 1;
} else {
  console.error('Workflow ended with status:', result.status);
  process.exitCode = 1;
}
