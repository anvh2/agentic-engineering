import { mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Spawned agent processes: the third of three separate things that used to be blurred together.
 *
 *   logical worker slot   a scheduler lease (tasks.lease_owner, `worker-<pid>-wN`): permission to run one task's lifecycle
 *   agent process         THIS table: one real OS process, spawned and supervised by the runtime, with its own identity,
 *                         spec, model, worktree, log, events and exit status
 *   model permit          the machine-wide capacity database (~/.agentic-engineering/model-capacity.db): one inference slot
 *
 * A row exists only because a process was actually spawned (or its spawn failed); nothing is inferred from IDE sessions or
 * logical slots. Lifecycle fields are updated by the supervising process; `agent_events` is append-only evidence. The tables
 * live in the scheduler database (created if absent, additive; no existing table changes).
 */

export const AGENT_STATUSES = ['SPAWNING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'SUPERSEDED', 'LOST', 'SPAWN_FAILED'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export const TERMINAL_AGENT_STATUSES: readonly AgentStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'SUPERSEDED', 'LOST', 'SPAWN_FAILED'];

/** What a RUNNING agent is doing right now, from its own events. Never guessed: no event, no activity. */
export const AGENT_ACTIVITIES = ['STARTING', 'WAITING_PERMIT', 'INFERENCE', 'TOOL', 'VERIFYING', 'FINISHING'] as const;
export type AgentActivity = (typeof AGENT_ACTIVITIES)[number];

export interface AgentExecutionRow {
  executionId: string;
  agentId: string;
  role: string;
  project: string | null;
  batchId: string | null;
  taskId: string;
  claimEpoch: number | null;
  runId: string | null;
  provider: string;
  /** The model the runtime assigned (`provider/model`); null when the provider chooses its own. */
  assignedModel: string | null;
  /** The model the provider reported having run; null = UNKNOWN (never copied from the assignment). */
  reportedModel: string | null;
  worktree: string;
  repositoryId: string | null;
  supervisor: string;
  host: string;
  pid: number | null;
  status: AgentStatus;
  activity: AgentActivity | null;
  activityDetail: string | null;
  spawnedAt: number;
  startedAt: number | null;
  heartbeatAt: number | null;
  endedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  outcome: string | null;
  failure: string | null;
  logPath: string | null;
  artifactDir: string | null;
  permitWaitMs: number;
  inferenceMs: number;
  toolCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AgentEventRow {
  seq: number;
  executionId: string;
  at: number;
  type: string;
  detail: Record<string, unknown> | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_executions (
  execution_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, role TEXT NOT NULL, project TEXT, batch_id TEXT, task_id TEXT NOT NULL,
  claim_epoch INTEGER, run_id TEXT, provider TEXT NOT NULL, assigned_model TEXT, reported_model TEXT,
  worktree TEXT NOT NULL, repository_id TEXT, supervisor TEXT NOT NULL, host TEXT NOT NULL, pid INTEGER,
  status TEXT NOT NULL, activity TEXT, activity_detail TEXT,
  spawned_at INTEGER NOT NULL, started_at INTEGER, heartbeat_at INTEGER, ended_at INTEGER,
  exit_code INTEGER, signal TEXT, outcome TEXT, failure TEXT, log_path TEXT, artifact_dir TEXT,
  permit_wait_ms INTEGER NOT NULL DEFAULT 0, inference_ms INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER, output_tokens INTEGER
);
CREATE INDEX IF NOT EXISTS agent_executions_task ON agent_executions(task_id);
CREATE INDEX IF NOT EXISTS agent_executions_status ON agent_executions(status);
CREATE TABLE IF NOT EXISTS agent_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, execution_id TEXT NOT NULL REFERENCES agent_executions(execution_id), at INTEGER NOT NULL,
  type TEXT NOT NULL, detail TEXT
);
CREATE INDEX IF NOT EXISTS agent_events_execution ON agent_events(execution_id);
CREATE TRIGGER IF NOT EXISTS agent_events_no_update BEFORE UPDATE ON agent_events BEGIN SELECT RAISE(ABORT, 'agent_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS agent_events_no_delete BEFORE DELETE ON agent_events BEGIN SELECT RAISE(ABORT, 'agent_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS agent_executions_no_delete BEFORE DELETE ON agent_executions BEGIN SELECT RAISE(ABORT, 'agent_executions rows are history'); END;
`;

const COLUMNS: Record<string, string> = {
  runId: 'run_id', reportedModel: 'reported_model', pid: 'pid', status: 'status', activity: 'activity', activityDetail: 'activity_detail',
  startedAt: 'started_at', heartbeatAt: 'heartbeat_at', endedAt: 'ended_at', exitCode: 'exit_code', signal: 'signal', outcome: 'outcome',
  failure: 'failure', logPath: 'log_path', artifactDir: 'artifact_dir', permitWaitMs: 'permit_wait_ms', inferenceMs: 'inference_ms',
  toolCalls: 'tool_calls', inputTokens: 'input_tokens', outputTokens: 'output_tokens',
};

function rowOf(r: Record<string, any>): AgentExecutionRow {
  return {
    executionId: r.execution_id, agentId: r.agent_id, role: r.role, project: r.project, batchId: r.batch_id, taskId: r.task_id,
    claimEpoch: r.claim_epoch, runId: r.run_id, provider: r.provider, assignedModel: r.assigned_model, reportedModel: r.reported_model,
    worktree: r.worktree, repositoryId: r.repository_id, supervisor: r.supervisor, host: r.host, pid: r.pid, status: r.status,
    activity: r.activity, activityDetail: r.activity_detail, spawnedAt: r.spawned_at, startedAt: r.started_at, heartbeatAt: r.heartbeat_at,
    endedAt: r.ended_at, exitCode: r.exit_code, signal: r.signal, outcome: r.outcome, failure: r.failure, logPath: r.log_path,
    artifactDir: r.artifact_dir, permitWaitMs: r.permit_wait_ms, inferenceMs: r.inference_ms, toolCalls: r.tool_calls,
    inputTokens: r.input_tokens, outputTokens: r.output_tokens,
  };
}

export type NewAgentExecution = Pick<AgentExecutionRow, 'executionId' | 'agentId' | 'role' | 'project' | 'batchId' | 'taskId' | 'claimEpoch' | 'runId' | 'provider' | 'assignedModel' | 'worktree' | 'repositoryId' | 'logPath' | 'artifactDir'>;

export class AgentStore {
  readonly db: DatabaseSync;
  private readonly owned: boolean;
  now: () => number;

  /** Opens the scheduler database at `path` (or uses an open handle) and adds the agent tables if they are missing. */
  constructor(pathOrDb: string | DatabaseSync, options: { now?: () => number } = {}) {
    if (typeof pathOrDb === 'string') {
      if (pathOrDb !== ':memory:') mkdirSync(dirname(pathOrDb), { recursive: true });
      this.db = new DatabaseSync(pathOrDb);
      this.db.exec('PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;');
      if (pathOrDb !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
      this.owned = true;
    } else {
      this.db = pathOrDb;
      this.owned = false;
    }
    this.now = options.now ?? Date.now;
    this.db.exec(SCHEMA);
  }

  close(): void {
    if (this.owned) this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw err;
    }
  }

  /** Records a spawn about to happen (status SPAWNING) and its first event. */
  create(input: NewAgentExecution, supervisor = `${hostname()}:${process.pid}`): AgentExecutionRow {
    const now = this.now();
    this.tx(() => {
      this.db.prepare(`INSERT INTO agent_executions (execution_id, agent_id, role, project, batch_id, task_id, claim_epoch, run_id, provider, assigned_model,
        worktree, repository_id, supervisor, host, status, spawned_at, log_path, artifact_dir) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        input.executionId, input.agentId, input.role, input.project, input.batchId, input.taskId, input.claimEpoch, input.runId, input.provider,
        input.assignedModel, input.worktree, input.repositoryId, supervisor, hostname(), 'SPAWNING', now, input.logPath, input.artifactDir,
      );
      this.db.prepare('INSERT INTO agent_events (execution_id, at, type, detail) VALUES (?,?,?,?)').run(input.executionId, now, 'spawn_requested', JSON.stringify({ provider: input.provider, model: input.assignedModel, worktree: input.worktree }));
    });
    return this.require(input.executionId);
  }

  /** Updates lifecycle fields. A terminal status is final: later writes (a late event from a dying process) are ignored. */
  update(executionId: string, patch: Partial<Omit<AgentExecutionRow, 'executionId'>>, event?: { type: string; detail?: Record<string, unknown> }): AgentExecutionRow | undefined {
    return this.tx(() => {
      const current = this.get(executionId);
      if (!current) return undefined;
      const terminal = TERMINAL_AGENT_STATUSES.includes(current.status);
      const sets: string[] = [];
      const values: (string | number | null)[] = [];
      if (!terminal) {
        for (const [key, value] of Object.entries(patch)) {
          const column = COLUMNS[key];
          if (!column) continue;
          sets.push(`${column} = ?`);
          values.push(value === undefined ? null : (value as string | number | null));
        }
        if (sets.length) this.db.prepare(`UPDATE agent_executions SET ${sets.join(', ')} WHERE execution_id = ?`).run(...values, executionId);
      }
      if (event) this.db.prepare('INSERT INTO agent_events (execution_id, at, type, detail) VALUES (?,?,?,?)').run(executionId, this.now(), event.type, event.detail ? JSON.stringify(event.detail) : null);
      return this.get(executionId);
    });
  }

  /** Appends evidence without changing lifecycle fields. */
  event(executionId: string, type: string, detail?: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO agent_events (execution_id, at, type, detail) VALUES (?,?,?,?)').run(executionId, this.now(), type, detail ? JSON.stringify(detail) : null);
  }

  get(executionId: string): AgentExecutionRow | undefined {
    const r = this.db.prepare('SELECT * FROM agent_executions WHERE execution_id = ?').get(executionId) as Record<string, any> | undefined;
    return r ? rowOf(r) : undefined;
  }

  require(executionId: string): AgentExecutionRow {
    const row = this.get(executionId);
    if (!row) throw new Error(`agent execution ${executionId} not found`);
    return row;
  }

  list(filter: { taskId?: string; batchId?: string; project?: string; statuses?: readonly AgentStatus[]; limit?: number } = {}): AgentExecutionRow[] {
    const where: string[] = [];
    const values: (string | number)[] = [];
    if (filter.taskId) (where.push('task_id = ?'), values.push(filter.taskId));
    if (filter.batchId) (where.push('batch_id = ?'), values.push(filter.batchId));
    if (filter.project) (where.push('project = ?'), values.push(filter.project));
    if (filter.statuses?.length) (where.push(`status IN (${filter.statuses.map(() => '?').join(',')})`), values.push(...filter.statuses));
    const sql = `SELECT * FROM agent_executions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY spawned_at DESC, execution_id LIMIT ${Math.max(1, Math.min(filter.limit ?? 500, 5000))}`;
    return (this.db.prepare(sql).all(...values) as Record<string, any>[]).map(rowOf);
  }

  events(executionId: string, limit = 500): AgentEventRow[] {
    return (this.db.prepare('SELECT * FROM agent_events WHERE execution_id = ? ORDER BY seq LIMIT ?').all(executionId, limit) as Record<string, any>[]).map((r) => ({
      seq: r.seq, executionId: r.execution_id, at: r.at, type: r.type, detail: r.detail ? JSON.parse(r.detail) : null,
    }));
  }
}
