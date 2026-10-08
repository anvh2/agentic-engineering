import type { WorkerLike } from '../../runtime/execution/coding-task-runner.ts';
import type { ProviderAvailability } from '../../runtime/execution/worker-provider.ts';

/** A worker that knows who it is (`provider`, required here) and whether it can run right now. */
export interface WorkerProvider extends WorkerLike {
  provider: NonNullable<WorkerLike['provider']>;
  /** Installation/auth state, cheap and side-effect free. Never returns or logs credentials. */
  probe(): Promise<ProviderAvailability>;
}
