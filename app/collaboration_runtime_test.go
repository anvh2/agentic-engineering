package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/anvh2/agentic-engineering/app/internal/collaboration"
)

func gitFixture(t *testing.T) string {
	t.Helper()
	repository := t.TempDir()
	command := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = repository
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, output)
		}
	}
	command("init", "-q")
	if err := os.WriteFile(filepath.Join(repository, "README.md"), []byte("# fixture\n"), 0600); err != nil {
		t.Fatal(err)
	}
	command("add", "README.md")
	command("-c", "user.name=Agentic Test", "-c", "user.email=agentic@example.test",
		"commit", "-qm", "initial")
	return repository
}

func TestM1ObjectiveUsesTeamAgentsRatherThanProviderAssignments(t *testing.T) {
	ctx := context.Background()
	base := t.TempDir()
	runner, err := collaboration.Open(ctx, filepath.Join(base, "collaboration.db"),
		filepath.Join(base, "evidence"))
	if err != nil { t.Fatal(err) }
	t.Cleanup(func() {
		shutdown, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := runner.Close(shutdown); err != nil { t.Error(err) }
	})
	m := &M1Runtime{ctx: ctx, runner: runner}
	repository := gitFixture(t)
	knowledge := t.TempDir()
	created, err := m.CreateM1Objective(M1CreateRequest{
		Repository: repository,
		Title: "Agent-based implementation", AcceptanceCriteria: "verified work",
		Developer: M1AgentSelection{ID: "team-alex", Name: "Alex",
			Handle: "alex", Role: "Developer", Harness: "Codex", Model: "Default",
			KnowledgeRoot: knowledge, Languages: []string{"go"}},
		Reviewer: M1AgentSelection{ID: "team-max", Name: "Max",
			Handle: "max", Role: "Reviewer", Harness: "Codex", Model: "codex-model",
			KnowledgeRoot: knowledge, Assigned: []string{"review-skill"}},
		Tasks: []string{"Implement", "Review"},
	})
	if err != nil { t.Fatal(err) }
	if len(created.Participants) != 2 || len(created.Tasks) != 2 { t.Fatalf("unexpected creation: %+v", created) }
	snapshot, err := m.GetM1Snapshot(created.ID)
	if err != nil { t.Fatal(err) }
	if len(snapshot.Participants) != 2 || len(snapshot.Objective.Participants) != 2 {
		t.Fatalf("unexpected snapshot: %+v", snapshot)
	}
	byHandle := make(map[string]string)
	byAgent := make(map[string]string)
	worktrees := make(map[string]bool)
	for _, participant := range snapshot.Participants {
		byHandle[participant.Handle] = participant.Agent
		byAgent[participant.Handle] = participant.AgentID
		if participant.Workdir == repository || worktrees[participant.Workdir] {
			t.Fatalf("participants must have separate worktrees: %+v", participant)
		}
		worktrees[participant.Workdir] = true
	}
	if byHandle["alex"] != "codex" || byHandle["max"] != "codex" ||
		byAgent["alex"] != "team-alex" || byAgent["max"] != "team-max" {
		t.Fatalf("Team identity collapsed to provider: agents=%v harness=%v", byAgent, byHandle)
	}
	if snapshot.Objective.Participants[0].AgentID == "" ||
		snapshot.Objective.Participants[1].AgentID == "" {
		t.Fatalf("MCP view omitted stable Agent IDs: %+v", snapshot.Objective.Participants)
	}
}
