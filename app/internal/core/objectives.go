package core

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
)

// Project is the business boundary.
type Project struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// CreateProject is a trusted (desktop) operation.
func (s *Service) CreateProject(ctx context.Context, name, description string) (Project, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return Project{}, invalid("project name is required")
	}
	p := Project{ID: newID("prj"), Name: name, Description: description}
	_, err := s.db.ExecContext(ctx, `INSERT INTO projects(id, name, description, created_at) VALUES (?, ?, ?, ?)`,
		p.ID, p.Name, p.Description, s.ts())
	return p, err
}

// ParticipantInput assigns an agent in a role. Workdir is the worktree the
// participant's sessions run in; it must be absolute.
type ParticipantInput struct {
	Agent   string
	Role    string
	Workdir string
}

// TaskInput seeds a task. Agents may add none in M1; tasks come from the
// Director or a planning turn through trusted calls.
type TaskInput struct {
	Title       string
	Description string
}

// ObjectiveInput is what the Director submits.
type ObjectiveInput struct {
	ProjectID          string
	Title              string
	Description        string
	AcceptanceCriteria string
	Participants       []ParticipantInput
	Tasks              []TaskInput
	WakeBudget         int // automatic wakes allowed before escalating; 0 uses DefaultWakeBudget
}

// DefaultWakeBudget bounds automatic wakes per objective so two agents cannot
// loop on each other unattended.
const DefaultWakeBudget = 24

// ObjectiveRecord is the trusted view returned on creation.
type ObjectiveRecord struct {
	ID           string
	Participants map[string]string // handle -> participant id
	Tasks        []Task
}

// CreateObjective is a trusted (desktop) operation.
func (s *Service) CreateObjective(ctx context.Context, in ObjectiveInput) (ObjectiveRecord, error) {
	if strings.TrimSpace(in.Title) == "" {
		return ObjectiveRecord{}, invalid("objective title is required")
	}
	if len(in.Participants) == 0 {
		return ObjectiveRecord{}, invalid("at least one participant is required")
	}
	budget := in.WakeBudget
	if budget <= 0 {
		budget = DefaultWakeBudget
	}
	rec := ObjectiveRecord{ID: newID("obj"), Participants: map[string]string{}}
	now := s.ts()
	err := s.tx(ctx, func(tx *sql.Tx) error {
		var one int
		if err := tx.QueryRowContext(ctx, `SELECT 1 FROM projects WHERE id = ?`, in.ProjectID).Scan(&one); errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO objectives(id, project_id, title, description, acceptance_criteria, status, wake_budget, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
			rec.ID, in.ProjectID, in.Title, in.Description, in.AcceptanceCriteria, budget, now, now); err != nil {
			return err
		}
		for _, p := range in.Participants {
			if p.Agent != "claude" && p.Agent != "codex" {
				return invalid("unknown agent %q", p.Agent)
			}
			if strings.TrimSpace(p.Role) == "" {
				return invalid("participant role is required")
			}
			if !filepath.IsAbs(p.Workdir) {
				return invalid("participant workdir must be absolute")
			}
			h := handleFor(p.Agent, p.Role)
			if h == HandleHuman || h == HandleSystem {
				return invalid("reserved handle %q", h)
			}
			if _, dup := rec.Participants[h]; dup {
				return invalid("duplicate participant %q", h)
			}
			id := newID("par")
			rec.Participants[h] = id
			if _, err := tx.ExecContext(ctx, `INSERT INTO participants(id, objective_id, handle, agent, role, workdir, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				id, rec.ID, h, p.Agent, p.Role, p.Workdir, now); err != nil {
				return err
			}
		}
		for _, t := range in.Tasks {
			if strings.TrimSpace(t.Title) == "" {
				return invalid("task title is required")
			}
			task := Task{ID: newID("tsk"), ObjectiveID: rec.ID, Title: t.Title, Description: t.Description, Status: TaskOpen, Revision: 1, UpdatedAt: parseTS(now)}
			if _, err := tx.ExecContext(ctx, `INSERT INTO tasks(id, objective_id, title, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?)`,
				task.ID, rec.ID, t.Title, t.Description, now, now); err != nil {
				return err
			}
			rec.Tasks = append(rec.Tasks, task)
		}
		return nil
	})
	if err != nil {
		return ObjectiveRecord{}, err
	}
	return rec, nil
}

// GetObjective returns the caller's objective with participants and tasks.
func (s *Service) GetObjective(ctx context.Context, p Principal) (ObjectiveView, error) {
	var v ObjectiveView
	err := s.db.QueryRowContext(ctx, `SELECT id, title, description, acceptance_criteria, status FROM objectives WHERE id = ?`, p.ObjectiveID).
		Scan(&v.ID, &v.Title, &v.Description, &v.AcceptanceCriteria, &v.Status)
	if errors.Is(err, sql.ErrNoRows) {
		return v, ErrNotFound
	}
	if err != nil {
		return v, err
	}
	v.You = Participant{Handle: p.Handle, Agent: p.Agent, Role: p.Role}
	rows, err := s.db.QueryContext(ctx, `SELECT handle, agent, role FROM participants WHERE objective_id = ? ORDER BY handle`, p.ObjectiveID)
	if err != nil {
		return v, err
	}
	defer rows.Close()
	for rows.Next() {
		var pt Participant
		if err := rows.Scan(&pt.Handle, &pt.Agent, &pt.Role); err != nil {
			return v, err
		}
		v.Participants = append(v.Participants, pt)
	}
	if err := rows.Err(); err != nil {
		return v, err
	}
	v.Tasks, err = s.listTasks(ctx, s.db, p.ObjectiveID)
	return v, err
}
