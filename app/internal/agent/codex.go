package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
)

// CodexArgs preserves user instructions, tools, skills and configuration. Only
// this application's bounded MCP tools are preapproved; execution remains in
// the native workspace-write sandbox. The token itself is never an argument.
func CodexArgs(spec TurnSpec) ([]string, error) {
	if spec.Binary.Kind != Codex || !filepath.IsAbs(spec.Binary.Path) || !filepath.IsAbs(spec.Workdir) || spec.Token == "" || spec.Prompt == "" {
		return nil, errors.New("invalid Codex turn specification")
	}
	u, err := url.Parse(spec.MCPURL)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.Path != "/mcp" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return nil, errors.New("Codex MCP endpoint must be local")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 {
		return nil, errors.New("invalid MCP port")
	}
	// Quote TOML string values, not shell text: argv is passed directly to exec.
	args := []string{"exec", "--json", "--sandbox", "workspace-write", "--cd", spec.Workdir,
		"-c", "mcp_servers." + MCPServerName + ".url=" + strconv.Quote(spec.MCPURL),
		"-c", "mcp_servers." + MCPServerName + ".bearer_token_env_var=" + strconv.Quote(TokenEnv),
		"-c", "mcp_servers." + MCPServerName + ".default_tools_approval_mode=\"approve\"",
	}
	if spec.Model != "" {
		args = append(args, "--model", spec.Model)
	}
	if spec.NativeSessionID != "" {
		// Never implicitly resume --last or accept a command-line switch as an ID.
		if strings.HasPrefix(spec.NativeSessionID, "-") || strings.ContainsAny(spec.NativeSessionID, "\x00\r\n") {
			return nil, errors.New("invalid native session ID")
		}
		args = append(args, "resume", spec.NativeSessionID)
	} else if spec.Instructions != "" {
		args = append(args, "-c", "developer_instructions="+strconv.Quote(spec.Instructions))
	}
	// Task text is consumed from stdin, not argv (which other processes can read).
	args = append(args, "-")
	return args, nil
}

type codexStream struct {
	result     TurnResult
	seq        int
	completed  bool
	completion []byte
	token      string
	emit       func(Event)
}

func (s *codexStream) line(line []byte) {
	line = bytes.TrimSpace(line)
	if len(line) == 0 {
		return
	}
	// Known application credentials must never enter raw events or diagnostics.
	if s.token != "" {
		line = bytes.ReplaceAll(line, []byte(s.token), []byte("[REDACTED]"))
	}
	var ev struct {
		Type     string          `json:"type"`
		ThreadID string          `json:"thread_id"`
		Usage    json.RawMessage `json:"usage"`
		Error    json.RawMessage `json:"error"`
		Message  string          `json:"message"`
		Item     struct {
			Type   string          `json:"type"`
			Text   string          `json:"text"`
			Status string          `json:"status"`
			Error  json.RawMessage `json:"error"`
		} `json:"item"`
	}
	if err := json.Unmarshal(line, &ev); err != nil || ev.Type == "" {
		s.result.NativeError = "invalid native event stream"
		return
	}
	s.seq++
	if ev.Type == "thread.started" {
		if ev.ThreadID == "" || (s.result.NativeSessionID != "" && s.result.NativeSessionID != ev.ThreadID) {
			s.result.NativeError = "native session identity mismatch"
		} else {
			s.result.NativeSessionID = ev.ThreadID
		}
	}
	if s.emit != nil {
		s.emit(Event{Seq: s.seq, Type: ev.Type, NativeID: s.result.NativeSessionID, Raw: append(json.RawMessage(nil), line...)})
	}
	switch ev.Type {
	case "item.completed":
		if ev.Item.Type == "agent_message" {
			s.result.FinalText = ev.Item.Text
		}
		if ev.Item.Status == "failed" || (len(ev.Item.Error) > 0 && string(ev.Item.Error) != "null") {
			s.result.ToolFailures++
		}
	case "turn.failed", "error":
		s.result.NativeError = "native turn failed"
	case "turn.completed":
		if s.completed {
			if !bytes.Equal(s.completion, ev.Usage) {
				s.result.NativeError = "conflicting terminal usage events"
			}
			return
		}
		s.completed = true
		s.completion = append([]byte(nil), ev.Usage...)
		if len(ev.Usage) > 0 && string(ev.Usage) != "null" {
			usage, err := codexUsage(ev.Usage)
			if err != nil {
				s.result.NativeError = "invalid native usage"
				return
			}
			s.result.Usage = []Usage{usage}
		}
	}
}
func codexUsage(raw json.RawMessage) (Usage, error) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil || m == nil {
		return Usage{}, errors.New("invalid usage object")
	}
	get := func(key string) (*int64, error) {
		v, ok := m[key]
		if !ok || string(v) == "null" {
			return nil, nil
		}
		var n int64
		if err := json.Unmarshal(v, &n); err != nil || n < 0 {
			return nil, fmt.Errorf("invalid %s", key)
		}
		return &n, nil
	}
	u := Usage{Provider: Codex, NormalizationVersion: NormalizationVersion, Raw: append(json.RawMessage(nil), raw...)}
	input, err := get("input_tokens")
	if err != nil {
		return u, err
	}
	for _, field := range []struct {
		key  string
		dest **int64
	}{{"cached_input_tokens", &u.CacheRead}, {"cache_write_input_tokens", &u.CacheWrite}, {"output_tokens", &u.Output}, {"reasoning_output_tokens", &u.Reasoning}} {
		*field.dest, err = get(field.key)
		if err != nil {
			return u, err
		}
	}
	if input != nil && u.CacheRead != nil {
		if *u.CacheRead > *input {
			return u, errors.New("cached input exceeds total input")
		}
		n := *input - *u.CacheRead
		u.UncachedInput = &n
	}
	// No model or billed cost is invented from the caller's optional model alias.
	return u, nil
}
func (s *codexStream) finish(exit int, interrupted bool, runErr error) (TurnResult, error) {
	s.result.ExitCode = exit
	s.result.Interrupted = interrupted
	if runErr != nil {
		return s.result, errors.New("native process failed")
	}
	if interrupted {
		return s.result, errors.New("native turn interrupted")
	}
	if exit != 0 {
		return s.result, errors.New("native process exited unsuccessfully")
	}
	if !s.completed || s.result.NativeSessionID == "" {
		return s.result, errors.New("native completion evidence missing")
	}
	if s.result.NativeError != "" || s.result.ToolFailures > 0 {
		return s.result, errors.New("native turn reported failures")
	}
	return s.result, nil
}
