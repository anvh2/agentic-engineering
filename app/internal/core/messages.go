package core

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"unicode/utf8"
)

// AfterUnread as the after argument of ReadMessages reads from the caller's
// own read cursor, returning only messages not fetched before.
const AfterUnread int64 = -1

// SendMessage stores a message from the caller to another participant, the
// human Director ("human") or everyone (""). Replaying the same idempotency
// key with the same recipient and body returns the original message.
func (s *Service) SendMessage(ctx context.Context, p Principal, in SendMessageInput) (Message, error) {
	if err := validateBody(in.Body, MaxMessageBytes, "message body"); err != nil {
		return Message{}, err
	}
	if in.IdempotencyKey == "" || len(in.IdempotencyKey) > MaxIdempotencyKeyBytes {
		return Message{}, invalid("idempotency_key is required and at most %d bytes", MaxIdempotencyKeyBytes)
	}
	if in.To == p.Handle {
		return Message{}, invalid("cannot send a message to yourself")
	}
	m, created, err := s.insertMessage(ctx, p.ObjectiveID, p.Handle, p.TurnID, in)
	if err == nil && created {
		s.notifyMessage(p.ObjectiveID)
	}
	return m, err
}

// PostHumanMessage is a trusted (desktop) operation: the Director writes into
// an objective's collaboration.
func (s *Service) PostHumanMessage(ctx context.Context, objectiveID, to, body, idempotencyKey string) (Message, error) {
	if err := validateBody(body, MaxMessageBytes, "message body"); err != nil {
		return Message{}, err
	}
	if idempotencyKey == "" {
		idempotencyKey = newID("hum")
	}
	m, created, err := s.insertMessage(ctx, objectiveID, HandleHuman, "", SendMessageInput{To: to, Body: body, IdempotencyKey: idempotencyKey})
	if err == nil && created {
		s.notifyMessage(objectiveID)
	}
	return m, err
}

func (s *Service) postSystemMessage(ctx context.Context, objectiveID, to, body, key string) error {
	_, _, err := s.insertMessage(ctx, objectiveID, HandleSystem, "", SendMessageInput{To: to, Body: body, IdempotencyKey: key})
	return err
}

func validateBody(v string, max int, what string) error {
	if strings.TrimSpace(v) == "" {
		return invalid("%s is required", what)
	}
	if len(v) > max {
		return invalid("%s exceeds %d bytes", what, max)
	}
	if !utf8.ValidString(v) {
		return invalid("%s must be valid UTF-8", what)
	}
	return nil
}

func (s *Service) insertMessage(ctx context.Context, objectiveID, from, fromTurn string, in SendMessageInput) (Message, bool, error) {
	digest := sha256Hex(in.To + "\x00" + in.Body)
	var out Message
	created := false
	err := s.tx(ctx, func(tx *sql.Tx) error {
		if in.To != "" && in.To != HandleHuman {
			var one int
			err := tx.QueryRowContext(ctx, `SELECT 1 FROM participants WHERE objective_id = ? AND handle = ?`, objectiveID, in.To).Scan(&one)
			if errors.Is(err, sql.ErrNoRows) {
				return ErrNotFound
			}
			if err != nil {
				return err
			}
		}
		var prevDigest string
		err := tx.QueryRowContext(ctx, `SELECT seq, id, to_handle, body, created_at, body_sha256 FROM messages
			WHERE objective_id = ? AND from_handle = ? AND idempotency_key = ?`, objectiveID, from, in.IdempotencyKey).
			Scan(&out.Seq, &out.ID, &out.To, &out.Body, scanTime(&out.CreatedAt), &prevDigest)
		if err == nil {
			if prevDigest != digest {
				return conflict("idempotency_key was already used with different content")
			}
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		now := s.ts()
		out = Message{ID: newID("msg"), To: in.To, Body: in.Body, CreatedAt: parseTS(now)}
		var turn any
		if fromTurn != "" {
			turn = fromTurn
		}
		res, err := tx.ExecContext(ctx, `INSERT INTO messages(id, objective_id, from_handle, from_turn_id, to_handle, body, body_sha256, idempotency_key, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, out.ID, objectiveID, from, turn, in.To, in.Body, digest, in.IdempotencyKey, now)
		if err != nil {
			return err
		}
		out.Seq, err = res.LastInsertId()
		created = true
		return err
	})
	out.ObjectiveID = objectiveID
	out.From = from
	return out, created, err
}

// ReadMessages returns messages addressed to the caller or to everyone, from
// others, in sequence order. It advances the caller's read cursor to the last
// returned message; this records that messages were fetched, not acted upon.
func (s *Service) ReadMessages(ctx context.Context, p Principal, after int64, limit int) (MessagePage, error) {
	if limit <= 0 {
		limit = DefaultReadLimit
	}
	if limit > MaxReadLimit {
		limit = MaxReadLimit
	}
	if after < AfterUnread {
		return MessagePage{}, invalid("after must be >= -1")
	}
	page := MessagePage{Messages: []Message{}}
	err := s.tx(ctx, func(tx *sql.Tx) error {
		if after == AfterUnread {
			if err := tx.QueryRowContext(ctx, `SELECT read_seq FROM participants WHERE id = ?`, p.ParticipantID).Scan(&after); err != nil {
				return err
			}
		}
		rows, err := tx.QueryContext(ctx, `SELECT seq, id, from_handle, to_handle, body, created_at FROM messages
			WHERE objective_id = ? AND seq > ? AND from_handle <> ? AND (to_handle = '' OR to_handle = ?)
			ORDER BY seq LIMIT ?`, p.ObjectiveID, after, p.Handle, p.Handle, limit+1)
		if err != nil {
			return err
		}
		for rows.Next() {
			m := Message{ObjectiveID: p.ObjectiveID}
			if err := rows.Scan(&m.Seq, &m.ID, &m.From, &m.To, &m.Body, scanTime(&m.CreatedAt)); err != nil {
				rows.Close()
				return err
			}
			page.Messages = append(page.Messages, m)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(page.Messages) > limit {
			page.Messages = page.Messages[:limit]
			page.HasMore = true
		}
		page.NextAfter = after
		if n := len(page.Messages); n > 0 {
			page.NextAfter = page.Messages[n-1].Seq
			_, err = tx.ExecContext(ctx, `UPDATE participants SET read_seq = MAX(read_seq, ?) WHERE id = ?`, page.NextAfter, p.ParticipantID)
		}
		return err
	})
	return page, err
}

// ListMessages is a trusted (desktop) read of an objective's full
// collaboration log in sequence order.
func (s *Service) ListMessages(ctx context.Context, objectiveID string, after int64, limit int) ([]Message, error) {
	if limit <= 0 || limit > 1000 {
		limit = 1000
	}
	rows, err := s.db.QueryContext(ctx, `SELECT seq, id, from_handle, to_handle, body, created_at FROM messages
		WHERE objective_id = ? AND seq > ? ORDER BY seq LIMIT ?`, objectiveID, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Message
	for rows.Next() {
		m := Message{ObjectiveID: objectiveID}
		if err := rows.Scan(&m.Seq, &m.ID, &m.From, &m.To, &m.Body, scanTime(&m.CreatedAt)); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
