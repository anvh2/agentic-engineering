import { codingWorker } from '../src/mastra/agents/coding-worker.ts';

const task = `Analyze this Go code:

func Add(a, b int) int {
    return a + b
}

Explain whether there are any issues and suggest tests.`;

console.log(`Sending task to codingWorker via ${process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'} ...\n`);

const result = await codingWorker.generate(task);

console.log(result.text);
