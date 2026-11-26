package core

import (
	"context"
	"database/sql"
	"errors"
)

type queryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

const taskColumns = `id, objective_id, title, description, status, owner_handle, summary, revision, updated_at`

func scanTask(sc interface{ Scan(...any) error }) (Task, error) {
	var t Task
	var status string
	err := sc.Scan(&t.ID, &t.ObjectiveID, &t.Title, &t.Description, &status, &t.Owner, &t.Summary, &t.Revision, scanTime(&t.UpdatedAt))
	t.Status = TaskStatus(status)
	return t, err
}

func (s *Service) listTasks(ctx context.Context, q queryer, objectiveID string) ([]Task, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+taskColumns+` FROM tasks WHERE objective_id = ? ORDER BY created_at, id`, objectiveID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Task{}
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// getTaskForUpdate loads a task inside the caller's objective. Tasks of other
// objectives are reported as not found.
func getTaskForUpdate(ctx context.Context, tx *sql.Tx, objectiveID, taskID string) (Task, error) {
	t, err := scanTask(tx.QueryRowContext(ctx, `SELECT `+taskColumns+` FROM tasks WHERE id = ? AND objective_id = ?`, taskID, objectiveID))
	if errors.Is(err, sql.ErrNoRows) {
		return t, ErrNotFound
	}
	return t, err
}

func (s *Service) writeTask(ctx context.Context, tx *sql.Tx, t *Task) error {
	now := s.ts()
	res, err := tx.ExecContext(ctx, `UPDATE tasks SET status = ?, owner_handle = ?, summary = ?, revision = revision + 1, updated_at = ?
		WHERE id = ? AND revision = ?`, string(t.Status), t.Owner, t.Summary, now, t.ID, t.Revision)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return conflict("task changed concurrently")
	}
	t.Revision++
	t.UpdatedAt = parseTS(now)
	return nil
}

// ClaimTask makes the caller the owner of an open task. Exactly one of any
// number of concurrent claimers with the same expected revision succeeds.
func (s *Service) ClaimTask(ctx context.Context, p Principal, taskID string, expectedRevision int64) (Task, error) {
	var t Task
	err := s.tx(ctx, func(tx *sql.Tx) error {
		var err error
		if t, err = getTaskForUpdate(ctx, tx, p.ObjectiveID, taskID); err != nil {
			return err
		}
		if t.Revision != expectedRevision {
			return conflict("revision is %d", t.Revision)
		}
		if t.Status != TaskOpen {
			return conflict("task is %s, owned by %q", t.Status, t.Owner)
		}
		t.Status, t.Owner = TaskInProgress, p.Handle
		return s.writeTask(ctx, tx, &t)
	})
	return t, err
}

// agentSettable is the set of statuses an owner may move a task to.
var agentSettable = map[TaskStatus]bool{TaskOpen: true, TaskInProgress: true, TaskBlocked: true, TaskSubmitted: true}

// UpdateTask changes a task the caller owns. Setting TaskOpen releases it.
// Agents can never set accepted or rejected.
func (s *Service) UpdateTask(ctx context.Context, p Principal, in UpdateTaskInput) (Task, error) {
	if !agentSettable[in.Status] {
		if in.Status == TaskAccepted || in.Status == TaskRejected {
			return Task{}, ErrForbidden
		}
		return Task{}, invalid("unknown status %q", in.Status)
	}
	if len(in.Summary) > MaxSummaryBytes {
		return Task{}, invalid("summary exceeds %d bytes", MaxSummaryBytes)
	}
	var t Task
	err := s.tx(ctx, func(tx *sql.Tx) error {
		var err error
		if t, err = getTaskForUpdate(ctx, tx, p.ObjectiveID, in.TaskID); err != nil {
			return err
		}
		if t.Revision != in.ExpectedRevision {
			return conflict("revision is %d", t.Revision)
		}
		if t.Owner != p.Handle {
			return conflict("task is owned by %q", t.Owner)
		}
		if t.Status == TaskAccepted {
			return conflict("task is accepted")
		}
		t.Status, t.Summary = in.Status, in.Summary
		if in.Status == TaskOpen {
			t.Owner = ""
		}
		return s.writeTask(ctx, tx, &t)
	})
	return t, err
}

// SetTaskVerdict is a trusted operation recording the result of independent
// verification and review of a submitted task.
func (s *Service) SetTaskVerdict(ctx context.Context, objectiveID, taskID string, expectedRevision int64, accepted bool, summary string) (Task, error) {
	var t Task
	err := s.tx(ctx, func(tx *sql.Tx) error {
		var err error
		if t, err = getTaskForUpdate(ctx, tx, objectiveID, taskID); err != nil {
			return err
		}
		if t.Revision != expectedRevision {
			return conflict("revision is %d", t.Revision)
		}
		if t.Status != TaskSubmitted {
			return conflict("only a submitted task can be judged; task is %s", t.Status)
		}
		t.Status = TaskRejected
		if accepted {
			t.Status = TaskAccepted
		}
		t.Summary = summary
		return s.writeTask(ctx, tx, &t)
	})
	return t, err
}
