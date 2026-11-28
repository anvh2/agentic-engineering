package core

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/anvh2/agentic-engineering/app/internal/agent"
)

// ErrWakeBudgetExhausted means the objective used every automatic wake. The
// human must raise the budget or act.
var ErrWakeBudgetExhausted = errors.New("wake budget exhausted")

// MaxTurnDuration bounds a token's lifetime even if a turn is never finished.
const MaxTurnDuration = 4 * time.Hour

// Trigger is why a turn started.
type Trigger string

const (
	TriggerStart Trigger = "start"
	TriggerWake  Trigger = "wake"
	TriggerHuman Trigger = "human"
)

// TurnLease is everything needed to run one native turn. Token is the only
// copy of the plaintext credential; it is never persisted.
type TurnLease struct {
	TurnID          string
	SessionID       string
	ObjectiveID     string
	Handle          string
	Agent           agent.Kind
	Workdir         string
	NativeSessionID string // empty for a new Codex session; pre-assigned for a new Claude session
	NewSession      bool
	Instructions    string // bootstrap context; only meaningful when NewSession
	Token           string
}

// BeginTurn records the intent to run a turn before any process starts,
// creating the participant's session if it has none, and mints the turn's
// credential. It fails with ErrConflict while another turn of the same
// session runs, and with ErrWakeBudgetExhausted for an over-budget wake.
//
// instructions is used only when a new session is created; the caller builds
// it from knowledge (see BuildBootstrap) and core stores it with its digest.
func (s *Service) BeginTurn(ctx context.Context, participantID string, trigger Trigger, prompt, instructions string, bin agent.Binary) (TurnLease, error) {
	if strings.TrimSpace(prompt) == "" {
		return TurnLease{}, invalid("prompt is required")
	}
	token, err := newToken()
	if err != nil {
		return TurnLease{}, err
	}
	var l TurnLease
	err = s.tx(ctx, func(tx *sql.Tx) error {
		var objStatus, agentName string
		var budget, used int
		err := tx.QueryRowContext(ctx, `SELECT p.objective_id, p.handle, p.agent, p.workdir, o.status, o.wake_budget, o.wakes_used
			FROM participants p JOIN objectives o ON o.id = p.objective_id WHERE p.id = ?`, participantID).
			Scan(&l.ObjectiveID, &l.Handle, &agentName, &l.Workdir, &objStatus, &budget, &used)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		l.Agent = agent.Kind(agentName)
		if objStatus != "active" {
			return conflict("objective is %s", objStatus)
		}
		if trigger == TriggerWake {
			if used >= budget {
				return ErrWakeBudgetExhausted
			}
			if _, err := tx.ExecContext(ctx, `UPDATE objectives SET wakes_used = wakes_used + 1 WHERE id = ?`, l.ObjectiveID); err != nil {
				return err
			}
		}
		now := s.ts()
		err = tx.QueryRowContext(ctx, `SELECT id, native_session_id FROM sessions WHERE participant_id = ? AND state = 'active'`, participantID).
			Scan(&l.SessionID, &l.NativeSessionID)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			l.NewSession = true
			l.SessionID = newID("ses")
			l.Instructions = instructions
			if l.Agent == agent.Claude {
				l.NativeSessionID = newUUID()
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO sessions(id, participant_id, native_session_id, binary_path, binary_version, workdir, context_text, context_digest, state, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`, l.SessionID, participantID, l.NativeSessionID, bin.Path, bin.Version, l.Workdir,
				instructions, sha256Hex(instructions), now); err != nil {
				return err
			}
		case err != nil:
			return err
		}
		l.TurnID = newID("trn")
		if _, err := tx.ExecContext(ctx, `INSERT INTO turns(id, session_id, seq, trigger, prompt, state, started_at)
			VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM turns WHERE session_id = ?), ?, ?, 'running', ?)`,
			l.TurnID, l.SessionID, l.SessionID, string(trigger), prompt, now); err != nil {
			if isUniqueViolation(err) {
				return conflict("a turn is already running for %s", l.Handle)
			}
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO turn_tokens(token_sha256, turn_id, expires_at) VALUES (?, ?, ?)`,
			sha256Hex(token), l.TurnID, s.now().Add(MaxTurnDuration).Format(time.RFC3339Nano))
		if err != nil {
			return err
		}
		if trigger == TriggerWake {
			// A wake is a notification, not a message acknowledgement.
			// Reserve the current message high-water mark in the same
			// transaction as the turn and wake budget. Failed turns may be
			// retried only by an explicit Director request.
			var newest int64
			if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(m.seq), 0)
				FROM messages m JOIN participants p ON p.objective_id = m.objective_id
				WHERE p.id = ? AND m.seq > p.notified_seq
				AND m.from_handle <> p.handle
				AND (m.to_handle = '' OR m.to_handle = p.handle)`, participantID).Scan(&newest); err != nil {
				return err
			}
			if newest > 0 {
				if _, err := tx.ExecContext(ctx, `UPDATE participants
					SET notified_seq = MAX(notified_seq, ?) WHERE id = ?`, newest, participantID); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return TurnLease{}, err
	}
	l.Token = token
	return l, nil
}

// requireLiveTurn re-validates, inside the caller's write transaction, that
// the principal's turn is still running. Authentication happens at HTTP
// admission; a turn finished or interrupted between admission and commit must
// not be able to write.
func requireLiveTurn(ctx context.Context, tx *sql.Tx, p Principal) error {
	var one int
	err := tx.QueryRowContext(ctx, `SELECT 1 FROM turns t JOIN sessions se ON se.id = t.session_id JOIN objectives o ON o.id = ?
		WHERE t.id = ? AND t.session_id = ? AND t.state = 'running' AND se.state = 'active' AND o.status = 'active'
		AND EXISTS (SELECT 1 FROM turn_tokens k WHERE k.turn_id = t.id AND k.revoked_at IS NULL)`, p.ObjectiveID, p.TurnID, p.SessionID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrUnauthenticated
	}
	return err
}

// RecordNativeSessionID stores a native id learned mid-turn (Codex reports
// its thread id at thread.started) so a crash before FinishTurn keeps it. Only
// a running turn may write it.
func (s *Service) RecordNativeSessionID(ctx context.Context, turnID, nativeID string) error {
	if nativeID == "" {
		return nil
	}
	return s.tx(ctx, func(tx *sql.Tx) error {
		return recordNativeSessionID(ctx, tx, turnID, nativeID)
	})
}

func recordNativeSessionID(ctx context.Context, tx *sql.Tx, turnID, nativeID string) error {
	res, err := tx.ExecContext(ctx, `UPDATE sessions SET native_session_id = ?
		WHERE id = (SELECT session_id FROM turns WHERE id = ? AND state = 'running')
		AND (native_session_id = '' OR native_session_id = ?)`, nativeID, turnID, nativeID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return conflict("session already has a different native id or the turn is not running")
	}
	return nil
}

// TurnOutcome is what the runner observed for a finished turn.
type TurnOutcome struct {
	Result    agent.TurnResult
	StartErr  error // the process could not be started or its stream failed
	LogPath   string
	LogSHA256 string
}

// FinishTurn records a turn's terminal state and usage and revokes its
// credential. Usage rows are idempotent per turn, provider and model.
func (s *Service) FinishTurn(ctx context.Context, turnID string, o TurnOutcome) error {
	r := o.Result
	state := "succeeded"
	switch {
	case r.Interrupted:
		state = "interrupted"
	case o.StartErr != nil, r.NativeError != "", r.ExitCode != 0:
		state = "failed"
	}
	nativeErr := r.NativeError
	if o.StartErr != nil && nativeErr == "" {
		nativeErr = o.StartErr.Error()
	}
	return s.tx(ctx, func(tx *sql.Tx) error {
		if r.NativeSessionID != "" {
			if err := recordNativeSessionID(ctx, tx, turnID, r.NativeSessionID); err != nil {
				return err
			}
		}
		now := s.ts()
		res, err := tx.ExecContext(ctx, `UPDATE turns SET state = ?, exit_code = ?, tool_failures = ?, native_error = ?, final_text = ?, log_path = ?, log_sha256 = ?, ended_at = ?
			WHERE id = ? AND state = 'running'`, state, r.ExitCode, r.ToolFailures, nativeErr, r.FinalText, o.LogPath, o.LogSHA256, now, turnID)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return conflict("turn is not running")
		}
		for _, u := range r.Usage {
			if err := s.recordUsage(ctx, tx, turnID, u); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE turn_tokens SET revoked_at = ? WHERE turn_id = ? AND revoked_at IS NULL`, now, turnID); err != nil {
			return err
		}
		if state != "succeeded" && r.NativeSessionID == "" {
			// A failed first launch may never have created a native session.
			// Retire that app session instead of retrying an invented ID.
			_, err = tx.ExecContext(ctx, `UPDATE sessions SET state = 'failed', closed_at = ?
				WHERE id = (SELECT session_id FROM turns WHERE id = ?) AND state = 'active'`, now, turnID)
		}
		return err
	})
}

// RecoverInterrupted runs at startup, before MCP serves: every turn still
// marked running belonged to a previous process, so it is marked interrupted
// and its credential revoked. Native sessions stay resumable.
func (s *Service) RecoverInterrupted(ctx context.Context) (int, error) {
	var n int64
	err := s.tx(ctx, func(tx *sql.Tx) error {
		now := s.ts()
		if _, err := tx.ExecContext(ctx, `UPDATE turn_tokens SET revoked_at = ? WHERE revoked_at IS NULL
			AND turn_id IN (SELECT id FROM turns WHERE state = 'running')`, now); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `UPDATE turns SET state = 'interrupted', native_error = 'application stopped during the turn', ended_at = ? WHERE state = 'running'`, now)
		if err != nil {
			return err
		}
		n, err = res.RowsAffected()
		return err
	})
	return int(n), err
}

// Authenticate resolves a per-turn bearer token to its Principal. It is
// called for every MCP request, so revocation and turn end take effect
// immediately.
func (s *Service) Authenticate(ctx context.Context, token string) (Principal, error) {
	if !strings.HasPrefix(token, tokenPrefix) || len(token) > 128 {
		return Principal{}, ErrUnauthenticated
	}
	var p Principal
	var expires string
	err := s.db.QueryRowContext(ctx, `SELECT t.id, se.id, pa.id, pa.handle, pa.agent, pa.agent_id, pa.agent_name, pa.role, pa.duty, o.id, o.project_id, k.expires_at
		FROM turn_tokens k
		JOIN turns t ON t.id = k.turn_id
		JOIN sessions se ON se.id = t.session_id
		JOIN participants pa ON pa.id = se.participant_id
		JOIN objectives o ON o.id = pa.objective_id
		WHERE k.token_sha256 = ? AND k.revoked_at IS NULL AND t.state = 'running' AND se.state = 'active' AND o.status = 'active'`,
		sha256Hex(token)).Scan(&p.TurnID, &p.SessionID, &p.ParticipantID, &p.Handle, &p.Agent, &p.AgentID, &p.AgentName, &p.Role, &p.Duty, &p.ObjectiveID, &p.ProjectID, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return Principal{}, ErrUnauthenticated
	}
	if err != nil {
		return Principal{}, err
	}
	if !s.now().Before(parseTS(expires)) {
		return Principal{}, ErrUnauthenticated
	}
	return p, nil
}

const tokenPrefix = "aet_"

func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return tokenPrefix + base64.RawURLEncoding.EncodeToString(b), nil
}

func newUUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("crypto/rand: %v", err))
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}
