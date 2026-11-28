package core

import (
	"context"
	"database/sql"
	"errors"
)

// ParticipantRecord is the trusted desktop view used to launch a native
// process. Agents cannot fetch this through MCP or change the workdir.
type ParticipantRecord struct {
	ID string `json:"id"`
	ObjectiveID string `json:"objectiveId"`
	Handle string `json:"handle"`
	Agent string `json:"agent"`
	Role string `json:"role"`
	Workdir string `json:"workdir"`
}

func (s *Service) GetParticipantRecord(ctx context.Context, participantID string) (ParticipantRecord, error) {
	var p ParticipantRecord
	err := s.db.QueryRowContext(ctx, `SELECT id, objective_id, handle, agent, role, workdir
		FROM participants WHERE id = ?`, participantID).
		Scan(&p.ID, &p.ObjectiveID, &p.Handle, &p.Agent, &p.Role, &p.Workdir)
	if errors.Is(err, sql.ErrNoRows) {
		return ParticipantRecord{}, ErrNotFound
	}
	if err != nil {
		return ParticipantRecord{}, err
	}
	return p, nil
}

// ListParticipantRecords is a trusted desktop read, not a discoverable MCP
// tool. Workdirs are never accepted from bearer-token-authenticated agents.
func (s *Service) ListParticipantRecords(ctx context.Context, objectiveID string) ([]ParticipantRecord, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, objective_id, handle, agent, role, workdir
		FROM participants WHERE objective_id = ? ORDER BY handle`, objectiveID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ParticipantRecord{}
	for rows.Next() {
		var p ParticipantRecord
		if err := rows.Scan(&p.ID, &p.ObjectiveID, &p.Handle, &p.Agent, &p.Role, &p.Workdir); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
