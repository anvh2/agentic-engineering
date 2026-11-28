package core

import "context"

// PendingWakeParticipants returns eligible, initialized participants with
// messages newer than their last wake notification. The durable budget and
// notification cursor are authoritatively checked in BeginTurn.
func (s *Service) PendingWakeParticipants(ctx context.Context, limit int) ([]ParticipantRecord, error) {
	if limit < 1 || limit > 32 {
		limit = 8
	}
	rows, err := s.db.QueryContext(ctx, `SELECT p.id, p.objective_id, p.handle, p.agent, p.role, p.workdir
		FROM participants p
		JOIN objectives o ON o.id = p.objective_id
		WHERE o.status = 'active' AND o.wakes_used < o.wake_budget
		AND EXISTS (SELECT 1 FROM sessions se
			WHERE se.participant_id = p.id AND se.state = 'active'
			  AND se.native_session_id <> '')
		AND EXISTS (SELECT 1 FROM messages m
			WHERE m.objective_id = p.objective_id AND m.seq > p.notified_seq
			  AND m.from_handle <> p.handle
			  AND (m.to_handle = '' OR m.to_handle = p.handle))
		ORDER BY p.created_at, p.id LIMIT ?`, limit)
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
