import { z } from 'zod';
import { codingDelegationSchema, type CodingDelegation } from '../workflows/coding-task-workflow.ts';
import { runClaudeCli } from './claude-cli.ts';

const SUPERVISOR_SYSTEM_PROMPT = `You are a supervisor agent. Turn the user's coding request into a structured delegation for a downstream coding worker.

Do not write code yourself. Do not invent requirements that were not stated or clearly implied by the request. Extract the task, the explicit requirements, and a short description of the expected output. If a repository is mentioned, do not restate its path yourself - just reflect that the task concerns that repository in your wording.`;

// The delegation's `repository` field is a security-sensitive filesystem
// path used to scope tool access. It always comes from the caller
// (planCodingTask's `options.repository`), never from the model's own
// output, so it's excluded from what we ask Claude to produce.
const supervisorOutputSchema = codingDelegationSchema.omit({ repository: true }).required();

/**
 * Invokes the local Claude Code CLI in non-interactive mode to turn a free-form
 * user request into a structured coding delegation. Uses whatever authentication
 * the CLI already has configured (Claude Pro/Max subscription login via `claude
 * auth login`) - no API key is read or required.
 */
export async function planCodingTask(
  userRequest: string,
  options: { repository?: string } = {},
): Promise<CodingDelegation> {
  // The CLI's structured-output mode only reliably populates
  // `structured_output` when every property is listed in the schema's
  // `required` array. The top-level `$schema` meta key that z.toJSONSchema()
  // adds also has to be stripped - the CLI silently drops structured_output
  // when it's present.
  const { $schema: _unused, ...jsonSchema } = z.toJSONSchema(supervisorOutputSchema);

  const promptWithContext = options.repository
    ? `Repository under analysis: ${options.repository}\n\n${userRequest}`
    : userRequest;

  const parsed = await runClaudeCli({
    prompt: promptWithContext,
    systemPrompt: SUPERVISOR_SYSTEM_PROMPT,
    jsonSchema,
  });
  if (parsed.is_error || parsed.structured_output === undefined) {
    throw new Error(`Claude supervisor failed to produce a delegation: ${parsed.result ?? 'unknown error'}`);
  }

  const delegation = supervisorOutputSchema.parse(parsed.structured_output);

  return { ...delegation, repository: options.repository };
}
