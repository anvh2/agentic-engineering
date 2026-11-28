-- A participant's duty on an objective is the Director's assignment. It is
-- independent of the Team agent's role name and native harness.
ALTER TABLE participants ADD COLUMN duty TEXT NOT NULL DEFAULT '' CHECK (duty IN ('', 'assignee', 'reviewer'));

-- Independent review verdicts, written only through a live reviewer turn.
CREATE TABLE reviews (
  id             TEXT PRIMARY KEY,
  objective_id   TEXT NOT NULL REFERENCES objectives(id),
  participant_id TEXT NOT NULL REFERENCES participants(id),
  turn_id        TEXT NOT NULL REFERENCES turns(id),
  verdict        TEXT NOT NULL CHECK (verdict IN ('approved', 'changes_requested')),
  summary        TEXT NOT NULL,
  verification   TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX reviews_by_objective ON reviews(objective_id);

-- Session-total counters as the harness reported them. usage_records columns
-- hold this turn's share (the difference from the previous report).
ALTER TABLE usage_records ADD COLUMN cumulative TEXT NOT NULL DEFAULT '';
