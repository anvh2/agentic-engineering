import { z } from 'zod';
// Wire vocabulary mirrors scheduler truth; a contract test guards against drift.
export const TASK_STATES = [
  'BACKLOG',
  'READY',
  'CLAIMED',
  'CODING',
  'VERIFYING',
  'REVIEW_PENDING',
  'APPROVED',
  'INTEGRATING',
  'DONE',
  'BLOCKED',
  'REVIEW_REJECTED',
  'ESCALATED',
  'RUNTIME_FAILURE',
  'CANCELLED',
] as const;

export const CONTRACT_VERSION = 'agentic.control-center/1' as const;
const time = z.number().int().nonnegative();
const measured = z.number().finite().nonnegative().nullable();
export const activitySchema = z.enum(['IDLE', 'QUEUED', 'RUNNING', 'VERIFYING', 'UNKNOWN', 'OFFLINE']);
export const eventNames = [
  'task.claimed',
  'task.queued',
  'provider.started',
  'provider.completed',
  'verification.started',
  'verification.completed',
  'task.review_pending',
  'task.failed',
  'task.cancelled',
  'task.transition',
  'task.audit',
] as const;
export const usageSchema = z.object({
  inputTokens: measured,
  outputTokens: measured,
  cachedInputTokens: measured,
  reasoningTokens: measured,
  latencyMs: measured,
  estimatedCost: z.object({ usd: z.number().nonnegative(), modelId: z.string(), pricingSource: z.string(), pricedAt: time }).nullable(),
  actualCostUsd: measured,
  source: z.enum(['unavailable', 'core.model-call']),
  completeness: z.enum(['unavailable', 'pending', 'partial', 'complete']),
});
export type Usage = z.infer<typeof usageSchema>;
export const unknownUsage = (): Usage => ({
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  reasoningTokens: null,
  latencyMs: null,
  estimatedCost: null,
  actualCostUsd: null,
  source: 'unavailable',
  completeness: 'unavailable',
});
/** Future Core seam. One immutable ID per physical call, including retries and cancelled calls. */
export const modelCallSchema = z.object({
  id: z.string(),
  objectiveId: z.string(),
  taskId: z.string(),
  runId: z.string(),
  workerId: z.string().nullable(),
  provider: z.string(),
  modelId: z.string().nullable(),
  attempt: z.number().int().positive(),
  startedAt: time,
  finishedAt: time.nullable(),
  status: z.enum(['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']),
  usage: usageSchema,
  /** What the provider declares it can report: 'none' makes missing counts NOT SUPPORTED rather than NOT REPORTED. */
  usageSupport: z.enum(['tokens', 'tokens-and-cost', 'none', 'unknown']).optional(),
});
export type ModelCall = z.infer<typeof modelCallSchema>;
export const eventSchema = z.object({
  id: z.string(),
  sequence: z.number().int().nonnegative(),
  at: time,
  taskId: z.string(),
  type: z.enum(eventNames),
  from: z.enum(TASK_STATES).nullable(),
  to: z.enum(TASK_STATES),
  source: z.literal('scheduler.events'),
  operation: z.enum(['workflow.started', 'lease.requeued', 'claims.extended']).nullable().optional(),
});
export type ControlEvent = z.infer<typeof eventSchema>;
export const taskSchema = z.object({
  id: z.string(),
  objectiveId: z.string(),
  title: z.string(),
  provider: z.string(),
  workerId: z.string().nullable(),
  state: z.enum(TASK_STATES),
  activity: activitySchema,
  stage: z.string(),
  execution: z.object({
    attempts: z.number().int().nonnegative(),
    runtimeRetries: z.number().int().nonnegative(),
    runtimeRequeues: z.number().int().nonnegative(),
    createdAt: time,
    finishedAt: time.nullable(),
    failureCategory: z.string().nullable(),
    reviewOutcome: z.string().nullable(),
    verifierExitCode: z.number().int().nullable().optional(),
    findings: z.array(z.object({ code: z.string(), severity: z.enum(['block', 'warn']) })).nullable().optional(),
    findingsOmitted: z.number().int().nonnegative().optional(),
  }).optional(),
  dependsOn: z.array(z.string()),
  runId: z.string().nullable(),
  runIds: z.array(z.string()),
  traceUrl: z.string().url().nullable(),
  claimedAt: time.nullable(),
  leaseExpiresAt: time.nullable(),
  updatedAt: time,
  lastEventAt: time.nullable(),
  activeSince: time.nullable(),
  elapsedMs: measured,
  stale: z.boolean(),
  queuePosition: z.number().int().positive().nullable(),
  usage: usageSchema,
});
export type ControlTask = z.infer<typeof taskSchema>;
export const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Null: an execution lane is a provider, not an identity; no role is inferred from its name. */
  role: z.enum(['lead', 'worker']).nullable(),
  parentId: z.string().nullable(),
  provider: z.string(),
  modelId: z.string().nullable(),
  /** ACTIVE: a current, non-expired lease. OBSERVED: persisted tasks only. Never an online state. */
  evidence: z.enum(['ACTIVE', 'OBSERVED']).optional(),
  activity: activitySchema,
  configured: z.boolean().nullable(),
  availability: z.enum(['UNKNOWN', 'AVAILABLE', 'UNAVAILABLE']),
  historicallyVerified: z.boolean(),
  assignmentIds: z.array(z.string()),
  lastOutcome: z.enum(TASK_STATES).nullable(),
  lastEventAt: time.nullable(),
  usage: usageSchema,
});
export type ControlAgent = z.infer<typeof agentSchema>;
export const snapshotSchema = z.object({
  version: z.literal(CONTRACT_VERSION),
  observedAt: time,
  source: z.enum(['connected', 'disconnected']),
  databaseId: z.string().nullable(),
  cursor: z.string().nullable(),
  objectiveId: z.string().nullable(),
  /** The resolved scope: a project from batches.project and the scheduler batches it covers. Optional for older readers. */
  scope: z.object({ project: z.string().nullable(), objectiveId: z.string().nullable(), objectiveIds: z.array(z.string()) }).optional(),
  objectives: z.array(z.object({ id: z.string(), label: z.string(), createdAt: time, kind: z.literal('scheduler-batch') })),
  tasks: z.array(taskSchema),
  agents: z.array(agentSchema),
  events: z.array(eventSchema),
  reviews: z.array(z.object({ id: z.number().int(), taskId: z.string(), createdAt: time, round: z.number().int() })),
  calls: z.array(modelCallSchema),
  usage: usageSchema,
  providers: z.array(
    z.object({
      id: z.string(),
      usage: usageSchema,
      quota: z.number().nullable(),
      permits: z.number().nullable(),
      permitsInUse: z.number().nullable(),
    }),
  ),
  eventSupport: z.record(z.string(), z.boolean()),
  limitations: z.array(z.string()),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
