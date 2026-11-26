// Package core is the V2 domain service. The desktop UI and the embedded MCP
// endpoint both call it directly; neither issues SQL.
//
// Contract for internal/mcp (owned by Codex):
//
//   - Authenticate the bearer token before any MCP protocol handling and pass
//     the returned Principal to every call. Identity and scope never come from
//     tool arguments.
//   - Map errors with errors.Is against the sentinels below. Messages of other
//     errors are internal and must not be returned to agents.
//   - Foreign-scope references return ErrNotFound, never a distinct error, so
//     existence does not leak across objectives.
package core

import (
	"errors"
	"time"
)

// Sentinel errors. Wrapped errors carry a safe, agent-readable detail after the
// sentinel text (for example "conflict: revision is 4").
var (
	ErrUnauthenticated = errors.New("unauthenticated")
	ErrNotFound        = errors.New("not found")
	ErrConflict        = errors.New("conflict")
	ErrInvalidArgument = errors.New("invalid argument")
	ErrForbidden       = errors.New("forbidden")
)

// Bounds enforced by core. MCP may pre-check them but core is authoritative.
const (
	MaxMessageBytes        = 16 << 10
	MaxSummaryBytes        = 4 << 10
	MaxIdempotencyKeyBytes = 128
	DefaultReadLimit       = 50
	MaxReadLimit           = 200
)

// Principal is the authenticated identity of one agent turn. It is derived
// only from a per-turn bearer token and is immutable for the request.
type Principal struct {
	SessionID     string
	TurnID        string
	ParticipantID string
	Handle        string // participant handle visible to agents, e.g. "codex-developer"
	ObjectiveID   string
	ProjectID     string
	Agent         string // "claude" | "codex"
	Role          string
}

// Message is a durable collaboration message. Seq is a per-database monotonic
// sequence used for ordering and cursors; wall-clock time is informational.
type Message struct {
	Seq         int64     `json:"seq"`
	ID          string    `json:"id"`
	ObjectiveID string    `json:"objective_id"`
	From        string    `json:"from"`         // sender participant handle; "human" for the Director
	To          string    `json:"to,omitempty"` // recipient handle; empty means every participant
	Body        string    `json:"body"`
	CreatedAt   time.Time `json:"created_at"`
}

// SendMessageInput is what an agent may choose. Author, scope and time are
// assigned by core.
type SendMessageInput struct {
	To             string // participant handle in the same objective, or "" for all
	Body           string
	IdempotencyKey string // required; same key + same content returns the original message, different content is ErrConflict
}

// MessagePage is a bounded, ordered read. Reading advances the caller's read
// cursor: it records "fetched", never "acted upon".
type MessagePage struct {
	Messages  []Message `json:"messages"`
	NextAfter int64     `json:"next_after"`
	HasMore   bool      `json:"has_more"`
}

// Participant is an agent assigned to an objective in a role. Sessions are
// attempts of a participant, so mail survives a replacement session.
type Participant struct {
	Handle string `json:"handle"`
	Agent  string `json:"agent"`
	Role   string `json:"role"`
}

// ObjectiveView is the scoped objective an agent may read.
type ObjectiveView struct {
	ID                 string        `json:"id"`
	Title              string        `json:"title"`
	Description        string        `json:"description"`
	AcceptanceCriteria string        `json:"acceptance_criteria"`
	Status             string        `json:"status"`
	You                Participant   `json:"you"`
	Participants       []Participant `json:"participants"`
	Tasks              []Task        `json:"tasks"`
}

// TaskStatus values. Agents may set Open (release), InProgress, Blocked and
// Submitted. Accepted and Rejected are set only by trusted callers after
// verification and review.
type TaskStatus string

const (
	TaskOpen       TaskStatus = "open"
	TaskInProgress TaskStatus = "in_progress"
	TaskBlocked    TaskStatus = "blocked"
	TaskSubmitted  TaskStatus = "submitted"
	TaskAccepted   TaskStatus = "accepted"
	TaskRejected   TaskStatus = "rejected"
)

// Task is a unit of owned work inside an objective. Revision increments on
// every change and is the compare-and-swap token for claims and updates.
type Task struct {
	ID          string     `json:"id"`
	ObjectiveID string     `json:"objective_id"`
	Title       string     `json:"title"`
	Description string     `json:"description,omitempty"`
	Status      TaskStatus `json:"status"`
	Owner       string     `json:"owner,omitempty"` // participant handle
	Summary     string     `json:"summary,omitempty"`
	Revision    int64      `json:"revision"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

// UpdateTaskInput changes a task the caller owns.
type UpdateTaskInput struct {
	TaskID           string
	ExpectedRevision int64
	Status           TaskStatus
	Summary          string
}
