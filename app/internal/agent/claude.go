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
	"strings"
)

// ClaudeAdapter executes headless Claude Code sessions. Native skills,
// permissions and user MCP servers are preserved. Only our scoped MCP server
// is granted without an interactive prompt, never filesystem or shell tools.
type ClaudeAdapter struct{}

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
		"--mcp-config", mcpConfigPath,
		"--allowedTools", "mcp__agentic_engineering__send_message",
		"mcp__agentic_engineering__read_messages",
		"mcp__agentic_engineering__get_objective",
		"mcp__agentic_engineering__claim_task",
		"mcp__agentic_engineering__update_task"}
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
	stream := &claudeStream{token: spec.Token, emit: emit}
	result, err := RunProcess(ctx, ProcessSpec{
		Path: spec.Binary.Path, Args: args, Dir: spec.Workdir,
		Env: CleanEnv(map[string]string{TokenEnv: spec.Token}),
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
	if result.Interrupted || result.ExitCode != 0 || stream.result.NativeError != "" {
		return stream.result, nil
	}
	if !stream.completed || stream.result.NativeSessionID == "" {
		return stream.result, errors.New("Claude completion evidence missing")
	}
	return stream.result, nil
}

type claudeStream struct {
	result TurnResult
	token string
	emit func(Event)
	seq int
	completed bool
}

func (s *claudeStream) line(line []byte) {
	line = bytes.TrimSpace(line)
	if len(line) == 0 {
		return
	}
	if s.token != "" {
		line = bytes.ReplaceAll(line, []byte(s.token), []byte("[REDACTED]"))
	}
	var event struct {
		Type string `json:"type"`
		SessionID string `json:"session_id"`
		Subtype string `json:"subtype"`
		IsError bool `json:"is_error"`
		Result string `json:"result"`
		Usage json.RawMessage `json:"usage"`
		TotalCost *float64 `json:"total_cost_usd"`
	}
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
		s.result.NativeError = "Claude turn failed"
	}
	if len(event.Usage) == 0 || string(event.Usage) == "null" {
		return
	}
	var u struct {
		Input *int64 `json:"input_tokens"`
		CacheRead *int64 `json:"cache_read_input_tokens"`
		CacheWrite *int64 `json:"cache_creation_input_tokens"`
		Output *int64 `json:"output_tokens"`
	}
	if err := json.Unmarshal(event.Usage, &u); err != nil ||
		(u.Input != nil && *u.Input < 0) || (u.CacheRead != nil && *u.CacheRead < 0) ||
		(u.CacheWrite != nil && *u.CacheWrite < 0) || (u.Output != nil && *u.Output < 0) {
		s.result.NativeError = "invalid Claude usage evidence"
		return
	}
	s.result.Usage = []Usage{{Provider: Claude, NormalizationVersion: NormalizationVersion,
		UncachedInput: u.Input, CacheRead: u.CacheRead, CacheWrite: u.CacheWrite,
		Output: u.Output, CostUSDEstimate: event.TotalCost,
		Raw: append(json.RawMessage(nil), event.Usage...)}}
}
