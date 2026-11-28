package core

import (
	"context"
	"database/sql"
	"time"
)

// TurnUsageSummary preserves unknown usage counters as NULL rather than
// converting them into misleading zeros. Costs are API-equivalent estimates.
type TurnUsageSummary struct {
	Provider      string   `json:"provider"`
	Model         string   `json:"model"`
	UncachedInput *int64   `json:"uncachedInput"`
	CacheRead     *int64   `json:"cacheRead"`
	CacheWrite    *int64   `json:"cacheWrite"`
	Output        *int64   `json:"output"`
	Reasoning     *int64   `json:"reasoning"`
	CostUSD       *float64 `json:"costUsd"`
	CostKind      string   `json:"costKind"`
}

type TurnSummary struct {
	TurnID          string             `json:"turnId"`
	SessionID       string             `json:"sessionId"`
	ParticipantID   string             `json:"participantId"`
	Handle          string             `json:"handle"`
	Agent           string             `json:"agent"` // native harness
	AgentID         string             `json:"agentId,omitempty"`
	Name            string             `json:"name,omitempty"`
	Role            string             `json:"role"`
	Trigger         string             `json:"trigger"`
	State           string             `json:"state"`
	StartedAt       time.Time          `json:"startedAt"`
	EndedAt         *time.Time         `json:"endedAt,omitempty"`
	ToolFailures    int                `json:"toolFailures"`
	NativeError     string             `json:"nativeError,omitempty"`
	FinalText       string             `json:"finalText,omitempty"`
	NativeSessionID string             `json:"nativeSessionId,omitempty"`
	LogPath         string             `json:"logPath"`
	LogSHA256       string             `json:"logSha256"`
	Usage           []TurnUsageSummary `json:"usage"`
}

// ListTurns is a trusted desktop query. The MCP agent interface intentionally
// offers no cross-session event or billing access.
func (s *Service) ListTurns(ctx context.Context, objectiveID string, limit int) ([]TurnSummary, error) {
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `SELECT t.id, t.session_id, p.id, p.handle, p.agent, p.agent_id, p.agent_name, p.role,
		t.trigger, t.state, t.started_at, t.ended_at, t.tool_failures, t.log_path, t.log_sha256,
		t.native_error, t.final_text, se.native_session_id
		FROM turns t JOIN sessions se ON se.id = t.session_id
		JOIN participants p ON p.id = se.participant_id
		WHERE p.objective_id = ?
		ORDER BY t.started_at DESC, t.id DESC LIMIT ?`, objectiveID, limit)
	if err != nil {
		return nil, err
	}
	out := []TurnSummary{}
	for rows.Next() {
		var (
			turn    TurnSummary
			started string
			ended   sql.NullString
		)
		if err := rows.Scan(&turn.TurnID, &turn.SessionID, &turn.ParticipantID,
			&turn.Handle, &turn.Agent, &turn.AgentID, &turn.Name, &turn.Role, &turn.Trigger, &turn.State,
			&started, &ended, &turn.ToolFailures, &turn.LogPath, &turn.LogSHA256,
			&turn.NativeError, &turn.FinalText, &turn.NativeSessionID); err != nil {
			_ = rows.Close()
			return nil, err
		}
		turn.StartedAt = parseTS(started)
		if ended.Valid {
			t := parseTS(ended.String)
			turn.EndedAt = &t
		}
		out = append(out, turn)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for i := range out {
		records, err := s.turnUsage(ctx, out[i].TurnID)
		if err != nil {
			return nil, err
		}
		out[i].Usage = records
	}
	return out, nil
}

func (s *Service) turnUsage(ctx context.Context, turnID string) ([]TurnUsageSummary, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT provider, model, uncached_input, cache_read,
		cache_write, output, reasoning, cost_usd_estimate, cost_kind
		FROM usage_records WHERE turn_id = ? ORDER BY provider, model`, turnID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TurnUsageSummary{}
	for rows.Next() {
		var (
			u                                         TurnUsageSummary
			input, cached, written, output, reasoning sql.NullInt64
			cost                                      sql.NullFloat64
		)
		if err := rows.Scan(&u.Provider, &u.Model, &input, &cached, &written,
			&output, &reasoning, &cost, &u.CostKind); err != nil {
			return nil, err
		}
		if input.Valid {
			n := input.Int64
			u.UncachedInput = &n
		}
		if cached.Valid {
			n := cached.Int64
			u.CacheRead = &n
		}
		if written.Valid {
			n := written.Int64
			u.CacheWrite = &n
		}
		if output.Valid {
			n := output.Int64
			u.Output = &n
		}
		if reasoning.Valid {
			n := reasoning.Int64
			u.Reasoning = &n
		}
		if cost.Valid {
			n := cost.Float64
			u.CostUSD = &n
		}
		out = append(out, u)
	}
	return out, rows.Err()
}
