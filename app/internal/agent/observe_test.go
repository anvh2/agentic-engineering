package agent

import (
	"encoding/json"
	"testing"
)

func observe(o *Observer, lines ...string) []Observation {
	var out []Observation
	for _, line := range lines {
		out = append(out, o.Observe(Event{Raw: json.RawMessage(line)})...)
	}
	return out
}

func TestCodexObservations(t *testing.T) {
	got := observe(NewObserver(Codex),
		`{"type":"item.started","item":{"type":"command_execution","command":"go test ./..."}}`,
		`{"type":"item.completed","item":{"type":"command_execution","command":"go test ./...","exit_code":1,"status":"failed","aggregated_output":"FAIL"}}`,
		`{"type":"item.completed","item":{"type":"file_change","status":"completed","changes":[{"path":"/w/a.go"}]}}`,
		`{"type":"item.completed","item":{"type":"mcp_tool_call","server":"agentic_engineering","tool":"send_message","status":"completed"}}`,
		`{"type":"item.completed","item":{"type":"agent_message","text":"I ran every test"}}`)
	if len(got) != 3 {
		t.Fatalf("observations %+v", got)
	}
	if got[0].Kind != ObservedCommand || !got[0].Failed || *got[0].ExitCode != 1 || got[0].Output != "FAIL" {
		t.Fatalf("command %+v", got[0])
	}
	if got[1].Kind != ObservedEdit || got[1].Paths[0] != "/w/a.go" || got[2].Tool != "send_message" {
		t.Fatalf("edit and message %+v", got[1:])
	}
}

func TestClaudeObservationsSeparateRefusalsFromResults(t *testing.T) {
	use := func(id, command string) string {
		return `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"` + id + `","name":"Bash","input":{"command":"` + command + `"}}]}}`
	}
	result := func(id string, isError bool, content string) string {
		flag := "false"
		if isError {
			flag = "true"
		}
		return `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"` + id + `","is_error":` + flag + `,"content":"` + content + `"}]}}`
	}
	got := observe(NewObserver(Claude),
		use("a", "npm test"), result("a", false, "pass"),
		use("b", "npm test"), result("b", true, "Exit code 2"),
		use("c", "npm test"), result("c", true, "This Bash command contains multiple operations. The following parts require approval"),
		`{"type":"user","message":{"content":"plain text"}}`,
		result("unknown", false, "ignored"))
	if len(got) != 3 {
		t.Fatalf("observations %+v", got)
	}
	if got[0].Failed || got[0].ExitCode != nil || got[0].Output != "pass" {
		t.Fatalf("success %+v", got[0])
	}
	if got[1].Kind != ObservedCommand || *got[1].ExitCode != 2 {
		t.Fatalf("failure %+v", got[1])
	}
	if got[2].Kind != ObservedDenied {
		t.Fatalf("a refused command never ran: %+v", got[2])
	}
}
