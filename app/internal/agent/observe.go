package agent

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

// ObservationKind classifies an action read from a native event stream.
type ObservationKind string

const (
	ObservedCommand       ObservationKind = "command"
	ObservedEdit          ObservationKind = "edit"
	ObservedCollaboration ObservationKind = "collaboration"
	// ObservedDenied is a call the native permission system or a hook refused;
	// nothing ran.
	ObservedDenied ObservationKind = "denied"
)

// Observation is one completed native action. It comes from the harness's own
// events, never from what the model says it did.
type Observation struct {
	Kind    ObservationKind
	Tool    string
	Command string
	Paths   []string
	// ExitCode is nil when the harness did not report one.
	ExitCode *int
	Failed   bool
	// Background marks a command whose completion was not observed.
	Background bool
	Output     string // bounded tail
}

const maxObservedOutput = 2 << 10

// Observer pairs native start and result events. Use one per turn.
type Observer struct {
	kind    Kind
	pending map[string]Observation
}

// NewObserver returns an Observer for one turn of the given harness.
func NewObserver(kind Kind) *Observer {
	return &Observer{kind: kind, pending: map[string]Observation{}}
}

// Observe returns the actions this event completes.
func (o *Observer) Observe(event Event) []Observation {
	if o.kind == Codex {
		return o.codex(event.Raw)
	}
	return o.claude(event.Raw)
}

func (o *Observer) codex(raw json.RawMessage) []Observation {
	var event struct {
		Type string `json:"type"`
		Item struct {
			Type     string `json:"type"`
			Command  string `json:"command"`
			ExitCode *int   `json:"exit_code"`
			Status   string `json:"status"`
			Output   string `json:"aggregated_output"`
			Server   string `json:"server"`
			Tool     string `json:"tool"`
			Changes  []struct {
				Path string `json:"path"`
			} `json:"changes"`
		} `json:"item"`
	}
	if err := json.Unmarshal(raw, &event); err != nil || event.Type != "item.completed" {
		return nil
	}
	item := event.Item
	failed := item.Status == "failed"
	if item.Type == "command_execution" {
		if item.Status == "declined" {
			return []Observation{{Kind: ObservedDenied, Tool: "shell", Command: item.Command, Failed: true}}
		}
		return []Observation{{Kind: ObservedCommand, Tool: "shell", Command: item.Command, ExitCode: item.ExitCode,
			Failed: failed || (item.ExitCode != nil && *item.ExitCode != 0), Output: tail(item.Output)}}
	}
	if item.Type == "file_change" {
		paths := make([]string, 0, len(item.Changes))
		for _, change := range item.Changes {
			paths = append(paths, change.Path)
		}
		return []Observation{{Kind: ObservedEdit, Tool: "file_change", Paths: paths, Failed: failed}}
	}
	if item.Type == "mcp_tool_call" && item.Server == MCPServerName {
		return []Observation{{Kind: ObservedCollaboration, Tool: item.Tool, Failed: failed}}
	}
	return nil
}

type claudeBlock struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	ToolUseID string          `json:"tool_use_id"`
	IsError   bool            `json:"is_error"`
	Content   json.RawMessage `json:"content"`
	Input     struct {
		Command      string `json:"command"`
		FilePath     string `json:"file_path"`
		NotebookPath string `json:"notebook_path"`
		Background   bool   `json:"run_in_background"`
	} `json:"input"`
}

func (o *Observer) claude(raw json.RawMessage) []Observation {
	var event struct {
		Type    string `json:"type"`
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(raw, &event); err != nil || (event.Type != "assistant" && event.Type != "user") {
		return nil
	}
	var blocks []claudeBlock
	if err := json.Unmarshal(event.Message.Content, &blocks); err != nil {
		return nil
	}
	var out []Observation
	for _, block := range blocks {
		if block.Type == "tool_use" {
			o.claudeStart(block)
			continue
		}
		if block.Type != "tool_result" {
			continue
		}
		observed, ok := o.pending[block.ToolUseID]
		if !ok {
			continue
		}
		delete(o.pending, block.ToolUseID)
		out = append(out, claudeFinish(observed, block))
	}
	return out
}

func (o *Observer) claudeStart(block claudeBlock) {
	prefix := "mcp__" + MCPServerName + "__"
	if block.Name == "Bash" {
		o.pending[block.ID] = Observation{Kind: ObservedCommand, Tool: block.Name,
			Command: block.Input.Command, Background: block.Input.Background}
		return
	}
	if block.Name == "Edit" || block.Name == "Write" || block.Name == "NotebookEdit" || block.Name == "MultiEdit" {
		path := block.Input.FilePath
		if path == "" {
			path = block.Input.NotebookPath
		}
		o.pending[block.ID] = Observation{Kind: ObservedEdit, Tool: block.Name, Paths: []string{path}}
		return
	}
	if strings.HasPrefix(block.Name, prefix) {
		o.pending[block.ID] = Observation{Kind: ObservedCollaboration, Tool: strings.TrimPrefix(block.Name, prefix)}
	}
}

var claudeExitCode = regexp.MustCompile(`^Exit code (\d+)`)

// claudeRefusals are the leading texts of results for calls that never ran.
var claudeRefusals = []string{"PreToolUse:", "<tool_use_error>", "Claude requested permissions",
	"This Bash command contains multiple operations", "This command requires approval", "Permission to use"}

func claudeFinish(observed Observation, block claudeBlock) Observation {
	text := claudeResultText(block.Content)
	observed.Failed = block.IsError
	if block.IsError {
		for _, refusal := range claudeRefusals {
			if strings.HasPrefix(text, refusal) {
				observed.Kind = ObservedDenied
				observed.Output = tail(text)
				return observed
			}
		}
	}
	if observed.Kind != ObservedCommand {
		return observed
	}
	observed.Output = tail(text)
	if match := claudeExitCode.FindStringSubmatch(text); block.IsError && match != nil {
		if code, err := strconv.Atoi(match[1]); err == nil {
			observed.ExitCode = &code
		}
	}
	return observed
}

func claudeResultText(content json.RawMessage) string {
	var text string
	if err := json.Unmarshal(content, &text); err == nil {
		return text
	}
	var parts []struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(content, &parts); err != nil {
		return ""
	}
	var out []string
	for _, part := range parts {
		out = append(out, part.Text)
	}
	return strings.Join(out, "\n")
}

func tail(s string) string {
	if len(s) <= maxObservedOutput {
		return s
	}
	return "…" + strings.ToValidUTF8(s[len(s)-maxObservedOutput:], "")
}
