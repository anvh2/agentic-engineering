// Package agent runs native Claude Code and Codex turns. One turn is one
// process: continuity between turns is the native session id, so no child
// process outlives its turn and nothing is reattached after a crash.
//
// Adapters translate a TurnSpec into native CLI arguments and parse the
// native structured stream. They never restrict native tools; the only
// pre-approval they add is for the app's own MCP server.
package agent

import (
	"context"
	"encoding/json"
)

// Kind identifies a native CLI.
type Kind string

const (
	Claude Kind = "claude"
	Codex  Kind = "codex"
)

// MCPServerName is the name the app's MCP server is registered under in each
// launched session, added beside the user's own servers (never replacing
// them). It is long enough not to collide with a user-defined server. Tool
// names become mcp__agentic_engineering__<tool> in Claude.
const MCPServerName = "agentic_engineering"

// TokenEnv is the only channel for the per-turn bearer token. It never appears
// in argv, configuration files or persisted events.
const TokenEnv = "AE_TOKEN"

// Binary is a resolved executable. Path is a realpath, never a shim that
// needs an interpreter missing from the GUI PATH.
type Binary struct {
	Kind    Kind   `json:"kind"`
	Path    string `json:"path"`
	Version string `json:"version"`
}

// TurnSpec describes one native turn.
type TurnSpec struct {
	Binary  Binary
	Workdir string // the session's worktree
	// NativeSessionID resumes an existing native session when set. When empty a
	// new native session is created; Claude adapters may pre-assign it through
	// NewSessionID so the id is persisted before the process starts.
	NativeSessionID string
	NewSessionID    string
	Prompt          string
	// Instructions is the role bootstrap. Applied only when creating a native
	// session: both CLIs persist it across resume (evidence E4, E7).
	Instructions string
	MCPURL       string
	Token        string
	Model        string // optional native model selector
}

// Event is one native structured event, preserved raw with its source order.
type Event struct {
	Seq      int             `json:"seq"`
	Type     string          `json:"type"`
	NativeID string          `json:"native_id,omitempty"`
	Raw      json.RawMessage `json:"raw"`
}

// Usage is one provider-reported usage record, normalized without inventing
// values. Nil means not reported. UncachedInput excludes cache reads and
// writes for every provider (Codex input_tokens includes cached tokens and is
// converted; Claude input_tokens already excludes them).
type Usage struct {
	Provider             Kind            `json:"provider"`
	Model                string          `json:"model,omitempty"`
	UncachedInput        *int64          `json:"uncached_input"`
	CacheRead            *int64          `json:"cache_read"`
	CacheWrite           *int64          `json:"cache_write"`
	Output               *int64          `json:"output"`
	Reasoning            *int64          `json:"reasoning"`
	CostUSDEstimate      *float64        `json:"cost_usd_estimate"` // provider-reported API-equivalent estimate; never a bill
	NormalizationVersion int             `json:"normalization_version"`
	Raw                  json.RawMessage `json:"raw"`
}

// NormalizationVersion is bumped whenever Usage mapping rules change.
const NormalizationVersion = 1

// TurnResult reports what the native stream said. Success is derived from
// structured events, never from the exit code alone: Codex exits 0 even when
// every MCP call was refused (evidence E5).
type TurnResult struct {
	NativeSessionID string  `json:"native_session_id"`
	FinalText       string  `json:"final_text"`
	Usage           []Usage `json:"usage"`
	// ToolFailures counts failed calls to the app's own MCP tools only (the
	// signal for a refused pre-approval, evidence E5). Failing native tools,
	// such as a red test run, are ordinary events and never fail a turn.
	ToolFailures int    `json:"tool_failures"`
	NativeError  string `json:"native_error,omitempty"`
	ExitCode     int    `json:"exit_code"`
	Interrupted  bool   `json:"interrupted"`
}

// Adapter runs one turn. emit receives every native event in source order,
// synchronously. Cancelling ctx interrupts the turn and returns with
// Interrupted set.
//
// Run returns a non-nil error only when there is no usable result: the
// process could not start, or its stream was unusable (unparseable, or no
// native session id). Interruption, a non-zero exit and a native error are
// reported in TurnResult; core classifies the turn from them.
type Adapter interface {
	Kind() Kind
	Run(ctx context.Context, spec TurnSpec, emit func(Event)) (TurnResult, error)
}
