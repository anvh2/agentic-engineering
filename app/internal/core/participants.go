package core

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

// ParticipantRecord is the trusted desktop view used to launch a native
// process. Agents cannot fetch this through MCP or change the workdir.
type ParticipantRecord struct {
	ID            string   `json:"id"`
	ObjectiveID   string   `json:"objectiveId"`
	Handle        string   `json:"handle"`
	Agent         string   `json:"agent"` // native harness
	AgentID       string   `json:"agentId,omitempty"`
	Name          string   `json:"name,omitempty"`
	Role          string   `json:"role"`
	Duty          Duty     `json:"duty,omitempty"`
	Model         string   `json:"model,omitempty"`
	KnowledgeRoot string   `json:"knowledgeRoot,omitempty"`
	Languages     []string `json:"languages,omitempty"`
	Assigned      []string `json:"assigned,omitempty"`
	languagesJSON string
	assignedJSON  string
	Workdir       string `json:"workdir"`
}

func (s *Service) GetParticipantRecord(ctx context.Context, participantID string) (ParticipantRecord, error) {
	var p ParticipantRecord
	err := s.db.QueryRowContext(ctx, `SELECT id, objective_id, handle, agent, role, workdir, agent_id, agent_name, model, knowledge_root, languages_json, assigned_json, duty
		FROM participants WHERE id = ?`, participantID).
		Scan(&p.ID, &p.ObjectiveID, &p.Handle, &p.Agent, &p.Role, &p.Workdir, &p.AgentID, &p.Name, &p.Model, &p.KnowledgeRoot, &p.languagesJSON, &p.assignedJSON, &p.Duty)
	if errors.Is(err, sql.ErrNoRows) {
		return ParticipantRecord{}, ErrNotFound
	}
	if err != nil {
		return ParticipantRecord{}, err
	}
	if err := p.decodeConfig(); err != nil {
		return ParticipantRecord{}, err
	}
	return p, nil
}

func (p *ParticipantRecord) decodeConfig() error {
	if err := json.Unmarshal([]byte(p.languagesJSON), &p.Languages); err != nil {
		return err
	}
	return json.Unmarshal([]byte(p.assignedJSON), &p.Assigned)
}

// ListParticipantRecords is a trusted desktop read, not a discoverable MCP
// tool. Workdirs are never accepted from bearer-token-authenticated agents.
func (s *Service) ListParticipantRecords(ctx context.Context, objectiveID string) ([]ParticipantRecord, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, objective_id, handle, agent, role, workdir, agent_id, agent_name, model, knowledge_root, languages_json, assigned_json, duty
		FROM participants WHERE objective_id = ? ORDER BY handle`, objectiveID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ParticipantRecord{}
	for rows.Next() {
		var p ParticipantRecord
		if err := rows.Scan(&p.ID, &p.ObjectiveID, &p.Handle, &p.Agent, &p.Role, &p.Workdir, &p.AgentID, &p.Name, &p.Model, &p.KnowledgeRoot, &p.languagesJSON, &p.assignedJSON, &p.Duty); err != nil {
			return nil, err
		}
		if err := p.decodeConfig(); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
