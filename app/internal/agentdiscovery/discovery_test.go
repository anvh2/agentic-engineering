package agentdiscovery
import "testing"
func TestUnsupportedAgent(t *testing.T){if s:=Scan("unknown","");s.State!="Error"{t.Fatalf("unexpected status: %+v",s)}}
func TestRelativeOverride(t *testing.T){if s:=Scan("Claude","relative/claude");s.State!="Error"{t.Fatalf("unexpected status: %+v",s)}}
func TestMissingOverride(t *testing.T){if s:=Scan("Codex","/nonexistent/agentic-engineering-test/codex");s.State!="Not installed"{t.Fatalf("unexpected status: %+v",s)}}
