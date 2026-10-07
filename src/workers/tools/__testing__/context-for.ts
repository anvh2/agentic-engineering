import { RequestContext } from '@mastra/core/request-context';
import { REPOSITORY_ROOT_CONTEXT_KEY } from '../repository-tools.ts';

/**
 * A minimal stand-in for the parts of Mastra's tool execution context these
 * tools actually read. Casting keeps tests focused on tool behavior instead
 * of reconstructing every unrelated field of ToolExecutionContext.
 */
export function contextFor(root: string) {
  const requestContext = new RequestContext();
  requestContext.set(REPOSITORY_ROOT_CONTEXT_KEY, root);
  return { requestContext } as any;
}
