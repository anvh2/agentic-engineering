import { codingTaskWorkflow } from '../src/mastra/workflows/coding-task-workflow.ts';

const task = `Write unit tests for this Go function:

func Add(a, b int) int {
	return a + b
}

Requirements:
- Use Go's standard testing package.
- Cover positive numbers.
- Cover zero values.
- Cover negative numbers.
- Return the test code and a short explanation.`;

console.log(`Running codingTaskWorkflow via ${process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'} ...\n`);

const run = await codingTaskWorkflow.createRun();
const result = await run.start({ inputData: { task } });

if (result.status === 'success') {
  console.log(result.result.result);
} else if (result.status === 'failed') {
  console.error('Workflow failed:', result.error);
  process.exitCode = 1;
} else {
  console.error('Workflow ended with status:', result.status);
  process.exitCode = 1;
}
