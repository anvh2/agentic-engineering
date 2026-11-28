package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ClaudeAdapter executes headless Claude Code sessions. Native skills, hooks,
// deny rules and user MCP servers are preserved. Our scoped MCP server is
// granted without an interactive prompt; file and shell access follow
// TurnSpec.Access, always inside Claude's own permission system.
type ClaudeAdapter struct{}

const claudeSandboxSettings = `{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false}}`

func (ClaudeAdapter) Kind() Kind { return Claude }

func ClaudeArgs(spec TurnSpec, mcpConfigPath string) ([]string, error) {
	if spec.Binary.Kind != Claude || !filepath.IsAbs(spec.Binary.Path) ||
		!filepath.IsAbs(spec.Workdir) || spec.Prompt == "" || spec.Token == "" ||
		!filepath.IsAbs(mcpConfigPath) {
		return nil, errors.New("invalid Claude turn specification")
	}
	if err := validateMCPURL(spec.MCPURL); err != nil {
		return nil, err
	}
	args := []string{"-p", "--output-format", "stream-json", "--verbose",
		"--mcp-config", mcpConfigPath, "--allowedTools"}
	for _, tool := range CollaborationTools {
		args = append(args, "mcp__"+MCPServerName+"__"+tool)
	}
	if spec.Access == AccessImplement || spec.Access == AccessReview {
		// Claude's own sandbox confines writes to the workspace and keeps the
		// network closed; the unsandboxed escape hatch stays disabled.
		args = append(args, "--settings", claudeSandboxSettings)
	}
	if spec.Access == AccessImplement {
		args = append(args, "--permission-mode", "acceptEdits")
	}
	for _, dir := range spec.AddDirs {
		if !filepath.IsAbs(dir) {
			return nil, errors.New("additional directories must be absolute")
		}
		args = append(args, "--add-dir", dir)
	}
	if spec.Model != "" {
		args = append(args, "--model", spec.Model)
	}
	if spec.NativeSessionID != "" {
		if strings.HasPrefix(spec.NativeSessionID, "-") || strings.ContainsAny(spec.NativeSessionID, "\x00\r\n") {
			return nil, errors.New("invalid Claude session id")
		}
		args = append(args, "--resume", spec.NativeSessionID)
	} else {
		if spec.NewSessionID == "" || strings.HasPrefix(spec.NewSessionID, "-") ||
			strings.ContainsAny(spec.NewSessionID, "\x00\r\n") {
			return nil, errors.New("new Claude session id required")
		}
		args = append(args, "--session-id", spec.NewSessionID)
		if spec.Instructions != "" {
			args = append(args, "--append-system-prompt", spec.Instructions)
		}
	}
	return args, nil
}

func validateMCPURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" ||
		u.Port() == "" || u.Path != "/mcp" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return errors.New("MCP endpoint must be local")
	}
	return nil
}

func writeClaudeMCPConfig(directory, endpoint string) (string, error) {
	if err := validateMCPURL(endpoint); err != nil {
		return "", err
	}
	// Claude expands the literal environment placeholder at launch; the
	// plaintext token never goes into the config or process arguments.
	config := map[string]any{"mcpServers": map[string]any{
		MCPServerName: map[string]any{
			"type": "http", "url": endpoint,
			"headers": map[string]string{"Authorization": "Bearer ${AE_TOKEN}"},
		},
	}}
	data, err := json.Marshal(config)
	if err != nil {
		return "", err
	}
	path := filepath.Join(directory, "mcp.json")
	if err := os.WriteFile(path, data, 0600); err != nil {
		return "", err
	}
	return path, nil
}

func (ClaudeAdapter) Run(ctx context.Context, spec TurnSpec, emit func(Event)) (TurnResult, error) {
	directory, err := os.MkdirTemp("", "ae-claude-mcp-*")
	if err != nil {
		return TurnResult{}, fmt.Errorf("create MCP config directory: %w", err)
	}
	defer func() { _ = os.RemoveAll(directory) }()
	path, err := writeClaudeMCPConfig(directory, spec.MCPURL)
	if err != nil {
		return TurnResult{}, err
	}
	args, err := ClaudeArgs(spec, path)
	if err != nil {
		return TurnResult{}, err
	}
	stream := &claudeStream{token: spec.Token, emit: emit, resumed: spec.NativeSessionID != ""}
	result, err := RunProcess(ctx, ProcessSpec{
		Path: spec.Binary.Path, Args: args, Dir: spec.Workdir,
		Env:   CleanEnv(map[string]string{TokenEnv: spec.Token}),
		Stdin: []byte(spec.Prompt), OnLine: stream.line,
	})
	if err != nil {
		if ctx.Err() != nil {
			stream.result.Interrupted = true
			return stream.result, nil
		}
		return stream.result, fmt.Errorf("run claude: %w", err)
	}
	stream.result.ExitCode = result.ExitCode
	stream.result.Interrupted = result.Interrupted
	stream.checkCollaboration()
	if result.Interrupted || result.ExitCode != 0 || stream.result.NativeError != "" {
		return stream.result, nil
	}
	if !stream.completed || stream.result.NativeSessionID == "" {
		return stream.result, errors.New("Claude completion evidence missing")
	}
	return stream.result, nil
}

type claudeStream struct {
	result    TurnResult
	token     string
	emit      func(Event)
	seq       int
	completed bool
	resumed   bool
	// collaboration holds the ids of in-flight calls to this app's MCP tools.
	collaboration map[string]bool
	succeeded     int
}

type claudeEvent struct {
	Type       string                     `json:"type"`
	SessionID  string                     `json:"session_id"`
	Subtype    string                     `json:"subtype"`
	IsError    bool                       `json:"is_error"`
	Result     string                     `json:"result"`
	Usage      json.RawMessage            `json:"usage"`
	ModelUsage map[string]json.RawMessage `json:"modelUsage"`
	TotalCost  *float64                   `json:"total_cost_usd"`
}

func (s *claudeStream) line(line []byte) {
	line = bytes.TrimSpace(line)
	if len(line) == 0 {
		return
	}
	if s.token != "" {
		line = bytes.ReplaceAll(line, []byte(s.token), []byte("[REDACTED]"))
	}
	var event claudeEvent
	if err := json.Unmarshal(line, &event); err != nil || event.Type == "" {
		s.result.NativeError = "invalid Claude event stream"
		return
	}
	s.seq++
	if event.SessionID != "" {
		if s.result.NativeSessionID != "" && s.result.NativeSessionID != event.SessionID {
			s.result.NativeError = "Claude session identity mismatch"
		} else {
			s.result.NativeSessionID = event.SessionID
		}
	}
	if s.emit != nil {
		s.emit(Event{Seq: s.seq, Type: event.Type, NativeID: s.result.NativeSessionID,
			Raw: append(json.RawMessage(nil), line...)})
	}
	if event.Type == "assistant" || event.Type == "user" {
		s.trackCollaboration(line)
	}
	if event.Type != "result" {
		return
	}
	if s.completed {
		s.result.NativeError = "duplicate Claude terminal event"
		return
	}
	s.completed = true
	s.result.FinalText = event.Result
	if event.IsError || event.Subtype != "success" {
		s.result.NativeError = nativeError("Claude turn failed", event.Result)
	}
	usage, err := claudeUsage(event, s.resumed)
	if err != nil {
		s.result.NativeError = "invalid Claude usage evidence"
		return
	}
	s.result.Usage = usage
}

func (s *claudeStream) trackCollaboration(line []byte) {
	var event struct {
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(line, &event); err != nil {
		return // Plain string content carries no tool blocks.
	}
	var blocks []claudeBlock
	if err := json.Unmarshal(event.Message.Content, &blocks); err != nil {
		return
	}
	for _, block := range blocks {
		if block.Type == "tool_use" && strings.HasPrefix(block.Name, "mcp__"+MCPServerName+"__") {
			if s.collaboration == nil {
				s.collaboration = map[string]bool{}
			}
			s.collaboration[block.ID] = true
		}
		if block.Type != "tool_result" || !s.collaboration[block.ToolUseID] {
			continue
		}
		delete(s.collaboration, block.ToolUseID)
		if block.IsError {
			s.result.ToolFailures++
		} else {
			s.succeeded++
		}
	}
}

func (s *claudeStream) checkCollaboration() {
	if s.result.NativeError == "" && s.result.ToolFailures > 0 && s.succeeded == 0 {
		s.result.NativeError = ErrCollaborationUnavailable
	}
}

type claudeCounters struct {
	Input      *int64   `json:"inputTokens"`
	CacheRead  *int64   `json:"cacheReadInputTokens"`
	CacheWrite *int64   `json:"cacheCreationInputTokens"`
	Output     *int64   `json:"outputTokens"`
	Reasoning  *int64   `json:"thinkingTokens"`
	Cost       *float64 `json:"costUSD"`
}

// claudeUsage prefers modelUsage, which covers every model the session used
// and totals the whole session. The older per-invocation usage object is the
// fallback; its session-total cost cannot be attributed to a resumed turn.
func claudeUsage(event claudeEvent, resumed bool) ([]Usage, error) {
	if len(event.ModelUsage) > 0 {
		models := make([]string, 0, len(event.ModelUsage))
		for model := range event.ModelUsage {
			models = append(models, model)
		}
		sort.Strings(models)
		out := make([]Usage, 0, len(models))
		for _, model := range models {
			var c claudeCounters
			if err := json.Unmarshal(event.ModelUsage[model], &c); err != nil {
				return nil, err
			}
			if negative(c.Input, c.CacheRead, c.CacheWrite, c.Output, c.Reasoning) || (c.Cost != nil && *c.Cost < 0) {
				return nil, errors.New("negative usage")
			}
			out = append(out, Usage{Provider: Claude, Model: model, NormalizationVersion: NormalizationVersion,
				UncachedInput: c.Input, CacheRead: c.CacheRead, CacheWrite: c.CacheWrite, Output: c.Output,
				Reasoning: c.Reasoning, CostUSDEstimate: c.Cost, SessionCumulative: true,
				Raw: append(json.RawMessage(nil), event.ModelUsage[model]...)})
		}
		return out, nil
	}
	if len(event.Usage) == 0 || string(event.Usage) == "null" {
		return nil, nil
	}
	var u struct {
		Input      *int64 `json:"input_tokens"`
		CacheRead  *int64 `json:"cache_read_input_tokens"`
		CacheWrite *int64 `json:"cache_creation_input_tokens"`
		Output     *int64 `json:"output_tokens"`
	}
	if err := json.Unmarshal(event.Usage, &u); err != nil {
		return nil, err
	}
	if negative(u.Input, u.CacheRead, u.CacheWrite, u.Output) {
		return nil, errors.New("negative usage")
	}
	cost := event.TotalCost
	if resumed {
		cost = nil
	}
	return []Usage{{Provider: Claude, NormalizationVersion: NormalizationVersion,
		UncachedInput: u.Input, CacheRead: u.CacheRead, CacheWrite: u.CacheWrite,
		Output: u.Output, CostUSDEstimate: cost,
		Raw: append(json.RawMessage(nil), event.Usage...)}}, nil
}

func negative(counters ...*int64) bool {
	for _, c := range counters {
		if c != nil && *c < 0 {
			return true
		}
	}
	return false
}
