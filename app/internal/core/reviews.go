package core

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// Duty is the Director's assignment of a participant on an objective.
type Duty string

const (
	DutyAssignee Duty = "assignee"
	DutyReviewer Duty = "reviewer"
)

// Verdict is an independent reviewer's conclusion about submitted work.
type Verdict string

const (
	VerdictApproved         Verdict = "approved"
	VerdictChangesRequested Verdict = "changes_requested"
)

// Review is one recorded verdict.
type Review struct {
	ID           string  `json:"id"`
	ObjectiveID  string  `json:"objective_id"`
	Reviewer     string  `json:"reviewer"` // participant handle
	TurnID       string  `json:"turn_id"`
	Verdict      Verdict `json:"verdict"`
	Summary      string  `json:"summary"`
	Verification string  `json:"verification"`
	CreatedAt    string  `json:"created_at"`
}

// SubmitReviewInput is what a reviewer may choose.
type SubmitReviewInput struct {
	Verdict      Verdict
	Summary      string
	Verification string // what the reviewer checked and the observed results
}

// SubmitReview records the verdict of the objective's reviewer and delivers it
// to the assignee as a message, atomically. Only a live turn of the reviewer
// may call it, and only while submitted work exists. A verdict is never
// acceptance: that stays with the Director.
func (s *Service) SubmitReview(ctx context.Context, p Principal, in SubmitReviewInput) (Review, error) {
	if in.Verdict != VerdictApproved && in.Verdict != VerdictChangesRequested {
		return Review{}, invalid("verdict must be %q or %q", VerdictApproved, VerdictChangesRequested)
	}
	if err := validateBody(in.Summary, MaxSummaryBytes, "review summary"); err != nil {
		return Review{}, err
	}
	if err := validateBody(in.Verification, MaxSummaryBytes, "review verification"); err != nil {
		return Review{}, err
	}
	review := Review{ID: newID("rev"), ObjectiveID: p.ObjectiveID, Reviewer: p.Handle, TurnID: p.TurnID,
		Verdict: in.Verdict, Summary: in.Summary, Verification: in.Verification}
	err := s.tx(ctx, func(tx *sql.Tx) error {
		if err := requireLiveTurn(ctx, tx, p); err != nil {
			return err
		}
		var duty Duty
		if err := tx.QueryRowContext(ctx, `SELECT duty FROM participants WHERE id = ? AND objective_id = ?`,
			p.ParticipantID, p.ObjectiveID).Scan(&duty); err != nil {
			return err
		}
		if duty != DutyReviewer {
			return ErrForbidden
		}
		var submitted int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM tasks WHERE objective_id = ? AND status = 'submitted'`,
			p.ObjectiveID).Scan(&submitted); err != nil {
			return err
		}
		if submitted == 0 {
			return conflict("no submitted work to review")
		}
		var assignee string
		err := tx.QueryRowContext(ctx, `SELECT handle FROM participants WHERE objective_id = ? AND duty = 'assignee'`,
			p.ObjectiveID).Scan(&assignee)
		if errors.Is(err, sql.ErrNoRows) {
			return conflict("objective has no assignee")
		}
		if err != nil {
			return err
		}
		review.CreatedAt = s.ts()
		if _, err := tx.ExecContext(ctx, `INSERT INTO reviews(id, objective_id, participant_id, turn_id, verdict, summary, verification, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, review.ID, p.ObjectiveID, p.ParticipantID, p.TurnID,
			string(in.Verdict), in.Summary, in.Verification, review.CreatedAt); err != nil {
			return err
		}
		body := fmt.Sprintf("Review verdict: %s\n\nFindings:\n%s\n\nVerification:\n%s", in.Verdict, in.Summary, in.Verification)
		_, err = tx.ExecContext(ctx, `INSERT INTO messages(id, objective_id, from_handle, from_turn_id, to_handle, body, body_sha256, idempotency_key, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, newID("msg"), p.ObjectiveID, p.Handle, p.TurnID, assignee, body,
			sha256Hex(assignee+"\x00"+body), "review-"+review.ID, review.CreatedAt)
		return err
	})
	if err != nil {
		return Review{}, err
	}
	s.notifyMessage(p.ObjectiveID)
	return review, nil
}

// ListReviews is a trusted desktop read in submission order.
func (s *Service) ListReviews(ctx context.Context, objectiveID string) ([]Review, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT r.id, r.objective_id, p.handle, r.turn_id, r.verdict, r.summary, r.verification, r.created_at
		FROM reviews r JOIN participants p ON p.id = r.participant_id
		WHERE r.objective_id = ? ORDER BY r.rowid`, objectiveID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Review{}
	for rows.Next() {
		var r Review
		if err := rows.Scan(&r.ID, &r.ObjectiveID, &r.Reviewer, &r.TurnID, &r.Verdict, &r.Summary, &r.Verification, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// requireReviewApproval refuses acceptance on an objective with a reviewer
// unless the latest verdict approves the work.
func requireReviewApproval(ctx context.Context, tx *sql.Tx, objectiveID string) error {
	var reviewers int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM participants WHERE objective_id = ? AND duty = 'reviewer'`,
		objectiveID).Scan(&reviewers); err != nil {
		return err
	}
	if reviewers == 0 {
		return nil
	}
	var verdict Verdict
	err := tx.QueryRowContext(ctx, `SELECT verdict FROM reviews WHERE objective_id = ? ORDER BY rowid DESC LIMIT 1`,
		objectiveID).Scan(&verdict)
	if errors.Is(err, sql.ErrNoRows) {
		return conflict("independent review is missing")
	}
	if err != nil {
		return err
	}
	if verdict != VerdictApproved {
		return conflict("independent review requested changes")
	}
	return nil
}
