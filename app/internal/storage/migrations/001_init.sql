-- V2 initial schema. Times are RFC 3339 UTC text. IDs are opaque text.

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

-- A repository is registered once and may serve many projects.
CREATE TABLE repositories (
  id           TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL UNIQUE, -- normalized remote URL, else absolute path of the primary checkout
  name         TEXT NOT NULL,
  local_path   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);

CREATE TABLE project_repositories (
  project_id    TEXT NOT NULL REFERENCES projects(id),
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  created_at    TEXT NOT NULL,
  PRIMARY KEY (project_id, repository_id)
);

CREATE TABLE objectives (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL CHECK (status IN ('active', 'done', 'cancelled')),
  wake_budget         INTEGER NOT NULL CHECK (wake_budget >= 0),
  wakes_used          INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- A participant is an agent in a role on one objective. Sessions are its attempts.
CREATE TABLE participants (
  id           TEXT PRIMARY KEY,
  objective_id TEXT NOT NULL REFERENCES objectives(id),
  handle       TEXT NOT NULL,
  agent        TEXT NOT NULL CHECK (agent IN ('claude', 'codex')),
  role         TEXT NOT NULL,
  workdir      TEXT NOT NULL,
  read_seq     INTEGER NOT NULL DEFAULT 0, -- highest message seq returned by read_messages (fetched, not acted upon)
  notified_seq INTEGER NOT NULL DEFAULT 0, -- highest message seq covered by a wake notice
  created_at   TEXT NOT NULL,
  UNIQUE (objective_id, handle)
);

CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,
  participant_id    TEXT NOT NULL REFERENCES participants(id),
  native_session_id TEXT NOT NULL DEFAULT '',
  binary_path       TEXT NOT NULL DEFAULT '',
  binary_version    TEXT NOT NULL DEFAULT '',
  workdir           TEXT NOT NULL,
  context_text      TEXT NOT NULL DEFAULT '', -- exact bootstrap injected at creation
  context_digest    TEXT NOT NULL DEFAULT '',
  state             TEXT NOT NULL CHECK (state IN ('active', 'closed', 'failed')),
  created_at        TEXT NOT NULL,
  closed_at         TEXT
);
CREATE UNIQUE INDEX sessions_one_active ON sessions(participant_id) WHERE state = 'active';

-- One native process per turn.
CREATE TABLE turns (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  seq            INTEGER NOT NULL,
  trigger        TEXT NOT NULL CHECK (trigger IN ('start', 'wake', 'human')),
  prompt         TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed', 'interrupted')),
  exit_code      INTEGER,
  tool_failures  INTEGER NOT NULL DEFAULT 0,
  native_error   TEXT NOT NULL DEFAULT '',
  final_text     TEXT NOT NULL DEFAULT '',
  log_path       TEXT NOT NULL DEFAULT '', -- raw native stream, 0600, outside the DB
  log_sha256     TEXT NOT NULL DEFAULT '',
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  UNIQUE (session_id, seq)
);
-- Single flight: at most one running turn per session, enforced by the database.
CREATE UNIQUE INDEX turns_one_running ON turns(session_id) WHERE state = 'running';

-- Per-turn bearer tokens. Only the SHA-256 is stored.
CREATE TABLE turn_tokens (
  token_sha256 TEXT PRIMARY KEY,
  turn_id      TEXT NOT NULL REFERENCES turns(id),
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT
);

CREATE TABLE messages (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  objective_id    TEXT NOT NULL REFERENCES objectives(id),
  from_handle     TEXT NOT NULL, -- participant handle, 'human' or 'system'
  from_turn_id    TEXT REFERENCES turns(id),
  to_handle       TEXT NOT NULL DEFAULT '', -- '' = every participant
  body            TEXT NOT NULL,
  body_sha256     TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (objective_id, from_handle, idempotency_key)
);
CREATE INDEX messages_by_objective ON messages(objective_id, seq);

CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  objective_id TEXT NOT NULL REFERENCES objectives(id),
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'blocked', 'submitted', 'accepted', 'rejected')),
  owner_handle TEXT NOT NULL DEFAULT '',
  summary      TEXT NOT NULL DEFAULT '',
  revision     INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX tasks_by_objective ON tasks(objective_id);

-- Provider-reported usage per turn and model. NULL means not reported.
CREATE TABLE usage_records (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id               TEXT NOT NULL REFERENCES turns(id),
  provider              TEXT NOT NULL,
  model                 TEXT NOT NULL DEFAULT '',
  uncached_input        INTEGER,
  cache_read            INTEGER,
  cache_write           INTEGER,
  output                INTEGER,
  reasoning             INTEGER,
  cost_usd_estimate     REAL,
  cost_kind             TEXT NOT NULL DEFAULT 'unknown', -- 'provider_api_equivalent_estimate' | 'unknown'
  normalization_version INTEGER NOT NULL,
  raw                   TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  UNIQUE (turn_id, provider, model)
);
