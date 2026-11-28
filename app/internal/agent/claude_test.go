package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func claudeFixture() TurnSpec {
	return TurnSpec{Binary: Binary{Kind: Claude, Path: "/opt/claude"},
		Workdir: "/repo/worktree", Prompt: "Inspect the objective",
		NewSessionID: "00000000-0000-4000-8000-000000000001",
		Instructions: "Role: Reviewer",
		MCPURL:       "http://127.0.0.1:41001/mcp", Token: "aet-private"}
}

func TestClaudeArgumentsPreserveNativePermissions(t *testing.T) {
	spec := claudeFixture()
	args, err := ClaudeArgs(spec, "/tmp/mcp.json")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	for _, want := range []string{"--session-id", "--append-system-prompt", "--mcp-config",
		"mcp__agentic_engineering__send_message", "mcp__agentic_engineering__get_objective"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %s", want)
		}
	}
	for _, dangerous := range []string{spec.Token, "--dangerously-skip-permissions", "--strict-mcp-config", "--tools",
		"--permission-mode", "--settings"} {
		if strings.Contains(joined, dangerous) {
			t.Errorf("unsafe argument %s", dangerous)
		}
	}
	spec.NativeSessionID = spec.NewSessionID
	spec.NewSessionID = ""
	args, err = ClaudeArgs(spec, "/tmp/mcp.json")
	if err != nil {
		t.Fatal(err)
	}
	joined = strings.Join(args, " ")
	if !strings.Contains(joined, "--resume") || strings.Contains(joined, "--session-id") || strings.Contains(joined, "--append-system-prompt") {
		t.Fatalf("resume duplicated bootstrap: %s", joined)
	}
}

func TestClaudeConfigUsesEnvironmentPlaceholder(t *testing.T) {
	spec := claudeFixture()
	dir := t.TempDir()
	path, err := writeClaudeMCPConfig(dir, spec.MCPURL)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), spec.Token) || !strings.Contains(string(raw), "${AE_TOKEN}") {
		t.Fatal("MCP config embedded credentials or lost env placeholder")
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("config permissions: %v %v", info, err)
	}
	if filepath.Dir(path) != dir {
		t.Fatalf("config escaped directory: %s", path)
	}
	for _, rawURL := range []string{"https://external.example/mcp", "http://localhost:41001/mcp",
		"http://127.0.0.1:41001/mcp?token=leak", "http://127.0.0.1:41001/other"} {
		if _, err := writeClaudeMCPConfig(dir, rawURL); err == nil {
			t.Errorf("unsafe URL accepted: %q", rawURL)
		}
	}
}

func TestClaudeEvidenceAndUsage(t *testing.T) {
	spec := claudeFixture()
	var events []Event
	stream := &claudeStream{token: spec.Token, emit: func(e Event) { events = append(events, e) }}
	stream.line([]byte(`{"type":"system","subtype":"init","session_id":"00000000-0000-4000-8000-000000000001"}`))
	stream.line([]byte(`{"type":"result","subtype":"success","session_id":"00000000-0000-4000-8000-000000000001","result":"Reviewed","usage":{"input_tokens":2,"cache_read_input_tokens":50,"cache_creation_input_tokens":4,"output_tokens":9},"total_cost_usd":0.001}`))
	if !stream.completed || stream.result.FinalText != "Reviewed" || stream.result.NativeError != "" {
		t.Fatalf("incomplete Claude result: %+v", stream.result)
	}
	if len(stream.result.Usage) != 1 || *stream.result.Usage[0].UncachedInput != 2 ||
		*stream.result.Usage[0].CacheRead != 50 || *stream.result.Usage[0].Output != 9 {
		t.Fatalf("unexpected usage: %+v", stream.result.Usage)
	}
	if len(events) != 2 || !json.Valid(events[1].Raw) {
		t.Fatalf("raw evidence missing: %+v", events)
	}
	stream.line([]byte(`{"type":"result","subtype":"success","session_id":"00000000-0000-4000-8000-000000000001"}`))
	if stream.result.NativeError != "duplicate Claude terminal event" {
		t.Fatal("duplicate result accepted")
	}
}

func TestClaudeMalformedStreamDoesNotBecomeSuccess(t *testing.T) {
	for _, payload := range []string{
		`not json`,
		`{"type":"result","subtype":"error","session_id":"s","result":"failed"}`,
		`{"type":"result","subtype":"success","session_id":"s","usage":{"input_tokens":-1}}`,
	} {
		s := &claudeStream{}
		s.line([]byte(payload))
		if s.result.NativeError == "" {
			t.Errorf("payload accepted: %s", payload)
		}
	}
}

func TestClaudeAccessStaysInsideNativeSandbox(t *testing.T) {
	for _, tc := range []struct {
		access            Access
		sandbox, autoEdit bool
	}{
		{AccessNative, false, false},
		{AccessImplement, true, true},
		{AccessReview, true, false},
	} {
		spec := claudeFixture()
		spec.Access, spec.AddDirs = tc.access, []string{"/repo/second"}
		args, err := ClaudeArgs(spec, "/tmp/mcp.json")
		if err != nil {
			t.Fatal(err)
		}
		joined := strings.Join(args, " ")
		if strings.Contains(joined, `"sandbox":{"enabled":true`) != tc.sandbox ||
			strings.Contains(joined, "--permission-mode acceptEdits") != tc.autoEdit {
			t.Fatalf("access %q: %s", tc.access, joined)
		}
		if tc.sandbox && !strings.Contains(joined, `"allowUnsandboxedCommands":false`) {
			t.Fatalf("unsandboxed escape left open: %s", joined)
		}
		for _, bypass := range []string{"bypassPermissions", "--dangerously-skip-permissions"} {
			if strings.Contains(joined, bypass) {
				t.Fatalf("permission bypass: %s", joined)
			}
		}
		if !strings.Contains(joined, "--add-dir /repo/second") ||
			!strings.Contains(joined, "mcp__agentic_engineering__submit_review") {
			t.Fatalf("missing workspace or tool grant: %s", joined)
		}
	}
}

func TestClaudeModelUsageIsSessionCumulative(t *testing.T) {
	s := &claudeStream{resumed: true}
	s.line([]byte(`{"type":"result","subtype":"success","session_id":"s","total_cost_usd":0.5,"usage":{"input_tokens":1},` +
		`"modelUsage":{"model-b":{"inputTokens":3,"outputTokens":4,"cacheReadInputTokens":5,"cacheCreationInputTokens":6,"costUSD":0.2},` +
		`"model-a":{"inputTokens":1,"outputTokens":2,"costUSD":0.1}}}`))
	if s.result.NativeError != "" || len(s.result.Usage) != 2 {
		t.Fatalf("usage %+v", s.result)
	}
	first := s.result.Usage[0]
	if first.Model != "model-a" || !first.SessionCumulative || *first.CostUSDEstimate != 0.1 || first.CacheRead != nil {
		t.Fatalf("model usage %+v", first)
	}
	fallback := &claudeStream{resumed: true}
	fallback.line([]byte(`{"type":"result","subtype":"success","session_id":"s","total_cost_usd":0.5,"usage":{"input_tokens":1}}`))
	if usage := fallback.result.Usage; len(usage) != 1 || usage[0].CostUSDEstimate != nil || usage[0].SessionCumulative {
		t.Fatalf("a session cost must not be attributed to a resumed turn: %+v", usage)
	}
}

func TestClaudeCollaborationOutageFailsTheTurn(t *testing.T) {
	call := `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"mcp__agentic_engineering__get_objective","input":{}}]}}`
	failed := `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"denied"}]}}`
	s := &claudeStream{}
	s.line([]byte(call))
	s.line([]byte(failed))
	s.checkCollaboration()
	if s.result.ToolFailures != 1 || s.result.NativeError != ErrCollaborationUnavailable {
		t.Fatalf("outage not reported: %+v", s.result)
	}
}
