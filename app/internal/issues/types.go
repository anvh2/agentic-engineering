// Package issues executes Working issues through the native collaboration
// runtime: the assignee implements, an independent reviewer judges, and only
// the Director accepts. Execution state is held in memory; native turns,
// messages, tasks, reviews and usage stay in the collaboration store.
package issues

import (
	"errors"

	"github.com/anvh2/agentic-engineering/app/internal/core"
	"github.com/anvh2/agentic-engineering/app/internal/workspace"
)

var (
	// ErrInvalidRequest wraps a reason the Director can fix.
	ErrInvalidRequest = errors.New("invalid issue execution request")
	// ErrNotFound means the issue has no execution in this app session.
	ErrNotFound = errors.New("issue has no execution")
	// ErrAlreadyRunning is the duplicate execution guard.
	ErrAlreadyRunning = errors.New("issue is already being executed")
	// ErrAwaitingDirector means a reviewed result waits for a decision.
	ErrAwaitingDirector = errors.New("issue is in review and waits for the Director")
	// ErrNotInReview means there is no reviewed result to accept.
	ErrNotInReview = errors.New("only an independently reviewed issue can be accepted")
	// ErrStale means the work changed after it was approved.
	ErrStale = errors.New("implementation changed after review approval")
)

// Phase is the execution state of an issue.
type Phase string

const (
	PhasePreparing    Phase = "preparing"
	PhaseImplementing Phase = "implementing"
	PhaseReviewing    Phase = "reviewing"
	PhaseRevising     Phase = "revising"
	PhaseResponding   Phase = "responding"
	PhaseStopping     Phase = "stopping"
	PhaseAccepting    Phase = "accepting"
	PhaseInReview     Phase = "in_review"
	PhaseAccepted     Phase = "accepted"
	PhaseStopped      Phase = "stopped"
	PhaseFailed       Phase = "failed"
)

// StartRequest is what the Director's board knows about an issue.
type StartRequest struct {
	IssueID            string `json:"issueId"`
	IssueKey           string `json:"issueKey"`
	ProjectID          string `json:"projectId"`
	ProjectName        string `json:"projectName"`
	Title              string `json:"title"`
	Description        string `json:"description"`
	AcceptanceCriteria string `json:"acceptanceCriteria"`
	AssigneeID         string `json:"assigneeId"`
	ReviewerID         string `json:"reviewerId"`
	// Repositories are every repository linked to the project; the first is the
	// primary working directory.
	Repositories []workspace.Repository `json:"repositories"`
	// Comments are Director comments written before the execution started.
	Comments []string `json:"comments"`
}

// AgentRef is the configuration snapshot of an assigned Team agent.
type AgentRef struct {
	ID      string    `json:"id"`
	Name    string    `json:"name"`
	Handle  string    `json:"handle"`
	Role    string    `json:"role"`
	Harness string    `json:"harness"`
	Model   string    `json:"model"`
	Duty    core.Duty `json:"duty"`
}

// RepositoryState is one linked repository's workspace and captured change.
type RepositoryState struct {
	ID             string           `json:"id"`
	Name           string           `json:"name"`
	Path           string           `json:"path"`
	BaseCommit     string           `json:"baseCommit"`
	AssigneeDir    string           `json:"assigneeDir"`
	ReviewerDir    string           `json:"reviewerDir"`
	SnapshotCommit string           `json:"snapshotCommit"`
	Files          []workspace.File `json:"files"`
	Patch          string           `json:"patch"`
	PatchTruncated bool             `json:"patchTruncated"`
	PatchSHA256    string           `json:"patchSha256"`
	PatchPath      string           `json:"patchPath"`
}

// Usage is one model's provider-reported usage in one run. Nil means the
// harness did not report it.
type Usage struct {
	Model       string `json:"model"`
	InputTokens *int64 `json:"inputTokens"` // includes cache reads and writes
	CacheRead   *int64 `json:"cacheRead"`
	CacheWrite  *int64 `json:"cacheWrite"`
	Output      *int64 `json:"outputTokens"`
	// CostUSD is the harness's own API-equivalent estimate.
	CostUSD *float64 `json:"costUsd"`
}

// Run is one native turn.
type Run struct {
	TurnID            string    `json:"turnId"`
	Duty              core.Duty `json:"duty"`
	AgentID           string    `json:"agentId"`
	AgentName         string    `json:"agentName"`
	Harness           string    `json:"harness"`
	Purpose           string    `json:"purpose"`
	State             string    `json:"state"` // running, succeeded, failed, interrupted
	StartedAt         string    `json:"startedAt"`
	EndedAt           string    `json:"endedAt"`
	Error             string    `json:"error"`
	FinalText         string    `json:"finalText"`
	Events            int       `json:"events"`
	ToolFailures      int       `json:"toolFailures"`
	Usage             []Usage   `json:"usage"`
	KnowledgeVersion  string    `json:"knowledgeVersion"`
	KnowledgeRevision string    `json:"knowledgeRevision"`
	EvidencePath      string    `json:"evidencePath"`
	EvidenceSHA256    string    `json:"evidenceSha256"`
	NativeSessionID   string    `json:"nativeSessionId"`
}

// Command is a shell command observed in a native event stream.
type Command struct {
	TurnID     string    `json:"turnId"`
	Duty       core.Duty `json:"duty"`
	AgentName  string    `json:"agentName"`
	Command    string    `json:"command"`
	ExitCode   *int      `json:"exitCode"`
	Failed     bool      `json:"failed"`
	Background bool      `json:"background"`
	// Test marks commands that look like a test run. The exit status is that
	// of the whole shell command.
	Test   bool   `json:"test"`
	Output string `json:"output"`
	At     string `json:"at"`
}

// Activity is one lifecycle or native action event.
type Activity struct {
	Seq   int    `json:"seq"`
	At    string `json:"at"`
	Kind  string `json:"kind"`
	Actor string `json:"actor"`
	Text  string `json:"text"`
}

// Message is a durable collaboration message.
type Message struct {
	Seq  int64  `json:"seq"`
	From string `json:"from"`
	To   string `json:"to"`
	Body string `json:"body"`
	At   string `json:"at"`
}

// Execution is the full view of one issue's execution.
type Execution struct {
	IssueID         string            `json:"issueId"`
	IssueKey        string            `json:"issueKey"`
	ProjectID       string            `json:"projectId"`
	Title           string            `json:"title"`
	Phase           Phase             `json:"phase"`
	Active          bool              `json:"active"`
	Detail          string            `json:"detail"`
	Error           string            `json:"error"`
	Attempt         int               `json:"attempt"`
	ReviewRounds    int               `json:"reviewRounds"`
	MaxReviewRounds int               `json:"maxReviewRounds"`
	PendingComments int               `json:"pendingComments"`
	ObjectiveID     string            `json:"objectiveId"`
	Assignee        AgentRef          `json:"assignee"`
	Reviewer        AgentRef          `json:"reviewer"`
	Repositories    []RepositoryState `json:"repositories"`
	Runs            []Run             `json:"runs"`
	Commands        []Command         `json:"commands"`
	Activity        []Activity        `json:"activity"`
	Messages        []Message         `json:"messages"`
	Reviews         []core.Review     `json:"reviews"`
	Tasks           []core.Task       `json:"tasks"`
	ApprovedReview  string            `json:"approvedReview"`
	AcceptedAt      string            `json:"acceptedAt"`
	AcceptNote      string            `json:"acceptNote"`
	UpdatedAt       string            `json:"updatedAt"`
}

// CommentResult tells the Director what happens to a comment.
type CommentResult struct {
	// Delivery is started, queued, on_retry or recorded.
	Delivery   string   `json:"delivery"`
	Recipients []string `json:"recipients"` // agent handles mentioned
}
