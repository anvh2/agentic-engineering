package agent

import (
	"encoding/json"
	"strings"
	"testing"
)

func spec() TurnSpec {
	return TurnSpec{Binary: Binary{Kind: Codex, Path: "/opt/codex"}, Workdir: "/repo/worktree", Prompt: "Read your objective", Instructions: "Global and role fundamentals", MCPURL: "http://127.0.0.1:42123/mcp", Token: "secret-turn-token"}
}
func TestCodexArgsPreserveNativeHarness(t *testing.T) {
	s := spec()
	args, err := CodexArgs(s)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	for _, forbidden := range []string{s.Token, "ignore-user-config", "--disable", "--tools", "bypass", "danger-full-access", "--last"} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("unexpected %s in args", forbidden)
		}
	}
	for _, required := range []string{"workspace-write", "developer_instructions=", "bearer_token_env_var=\"AE_TOKEN\"", "default_tools_approval_mode=\"approve\""} {
		if !strings.Contains(joined, required) {
			t.Fatalf("missing %s", required)
		}
	}
	s.NativeSessionID = "native-id"
	args, err = CodexArgs(s)
	if err != nil {
		t.Fatal(err)
	}
	joined = strings.Join(args, " ")
	if !strings.Contains(joined, "resume native-id") || strings.Contains(joined, "developer_instructions") {
		t.Fatal(joined)
	}
}
func TestCodexRejectsUnsafeLaunchInputs(t *testing.T) {
	for _, change := range []func(*TurnSpec){func(s *TurnSpec) { s.MCPURL = "https://remote.example/mcp" }, func(s *TurnSpec) { s.MCPURL = "http://127.0.0.1:4112/mcp?token=x" }, func(s *TurnSpec) { s.Workdir = "relative" }, func(s *TurnSpec) { s.NativeSessionID = "--last" }, func(s *TurnSpec) { s.Token = "" }} {
		s := spec()
		change(&s)
		if _, err := CodexArgs(s); err == nil {
			t.Fatal("unsafe launch accepted")
		}
	}
}
func TestCodexUsageNormalizationAndReplay(t *testing.T) {
	s := codexStream{}
	s.line([]byte(`{"type":"thread.started","thread_id":"native"}`))
	event := []byte(`{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":70,"cache_write_input_tokens":0,"output_tokens":9,"reasoning_output_tokens":4}}`)
	s.line(event)
	s.line(event)
	r, err := s.finish(0, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Usage) != 1 || *r.Usage[0].UncachedInput != 30 || *r.Usage[0].CacheRead != 70 || *r.Usage[0].Output != 9 || r.Usage[0].CostUSDEstimate != nil {
		t.Fatalf("usage %+v", r.Usage)
	}
}
func TestCodexZeroExitDoesNotMaskToolFailure(t *testing.T) {
	s := codexStream{}
	s.line([]byte(`{"type":"thread.started","thread_id":"native"}`))
	s.line([]byte(`{"type":"item.completed","item":{"type":"mcp_tool_call","status":"failed","error":{"message":"approval required"}}}`))
	s.line([]byte(`{"type":"turn.completed"}`))
	r, err := s.finish(0, false, nil)
	if err == nil || r.ToolFailures != 1 {
		t.Fatalf("false success %+v %v", r, err)
	}
}
func TestCodexUnknownAndMalformedUsage(t *testing.T) {
	u, err := codexUsage(json.RawMessage(`{"input_tokens":100}`))
	if err != nil || u.UncachedInput != nil || u.CacheRead != nil || u.Output != nil {
		t.Fatalf("unknown became zero: %+v %v", u, err)
	}
	for _, bad := range []string{`{"input_tokens":-1}`, `{"input_tokens":3,"cached_input_tokens":4}`, `{"output_tokens":1.5}`, `{"output_tokens":"3"}`, `null`} {
		if _, err := codexUsage(json.RawMessage(bad)); err == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
}
func TestCodexRedactsTokenAndChecksIdentity(t *testing.T) {
	var events []Event
	s := codexStream{token: "private-token", emit: func(e Event) { events = append(events, e) }}
	s.result.NativeSessionID = "expected"
	s.line([]byte(`{"type":"thread.started","thread_id":"other"}`))
	s.line([]byte(`{"type":"item.completed","item":{"type":"agent_message","text":"private-token"}}`))
	s.line([]byte(`{"type":"turn.completed"}`))
	if _, err := s.finish(0, false, nil); err == nil {
		t.Fatal("mismatched session accepted")
	}
	for _, e := range events {
		if strings.Contains(string(e.Raw), "private-token") {
			t.Fatal("token persisted")
		}
	}
	if strings.Contains(s.result.FinalText, "private-token") {
		t.Fatal("token in final text")
	}
}
func TestCodexRequiresTerminalEvidence(t *testing.T) {
	s := codexStream{}
	s.line([]byte(`{"type":"thread.started","thread_id":"native"}`))
	if _, err := s.finish(0, false, nil); err == nil {
		t.Fatal("exit alone accepted")
	}
	s.line([]byte(`{"type":"turn.completed","usage":{"output_tokens":1}}`))
	s.line([]byte(`{"type":"turn.completed","usage":{"output_tokens":2}}`))
	if _, err := s.finish(0, false, nil); err == nil {
		t.Fatal("conflicting usage accepted")
	}
}
