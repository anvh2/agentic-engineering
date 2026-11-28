-- Keep the legacy harness column for existing resumable sessions.
-- Stable Team agent identity and configuration are an immutable objective snapshot.
ALTER TABLE participants ADD COLUMN agent_id TEXT NOT NULL DEFAULT '';
ALTER TABLE participants ADD COLUMN agent_name TEXT NOT NULL DEFAULT '';
ALTER TABLE participants ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE participants ADD COLUMN knowledge_root TEXT NOT NULL DEFAULT '';
ALTER TABLE participants ADD COLUMN languages_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE participants ADD COLUMN assigned_json TEXT NOT NULL DEFAULT '[]';
