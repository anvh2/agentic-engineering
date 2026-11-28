package core

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"

	"github.com/anvh2/agentic-engineering/app/internal/agent"
	"github.com/anvh2/agentic-engineering/app/internal/storage"
)

// Team agent identity is independent from the native harness: multiple
// distinct agents may run on the same native provider.
func TestTeamAgentsShareHarnessWithDistinctIdentity(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "team.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	svc := New(db)
	project, err := svc.CreateProject(ctx, "test", "")
	if err != nil {
		t.Fatal(err)
	}
	knowledge := t.TempDir()
	workspace := t.TempDir()
	created, err := svc.CreateObjective(ctx, ObjectiveInput{
		ProjectID: project.ID, Title: "Team identity",
		Participants: []ParticipantInput{
			{Agent: "codex", AgentID: "agent-dev", Name: "Alex", Handle: "alex",
				Role: "Developer", Model: "gpt-test", KnowledgeRoot: knowledge,
				Languages: []string{"go"}, Assigned: []string{"skill-one"}, Workdir: workspace},
			{Agent: "codex", AgentID: "agent-review", Name: "Max", Handle: "max",
				Role: "Reviewer", Model: "Default", KnowledgeRoot: knowledge, Workdir: workspace},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(created.Participants) != 2 {
		t.Fatalf("participants: %+v", created.Participants)
	}
	dev, err := svc.GetParticipantRecord(ctx, created.Participants["alex"])
	if err != nil {
		t.Fatal(err)
	}
	if dev.AgentID != "agent-dev" || dev.Name != "Alex" || dev.Handle != "alex" ||
		dev.Role != "Developer" || dev.Agent != "codex" || dev.Model != "gpt-test" ||
		dev.KnowledgeRoot != knowledge || len(dev.Languages) != 1 ||
		dev.Languages[0] != "go" || len(dev.Assigned) != 1 ||
		dev.Assigned[0] != "skill-one" {
		t.Fatalf("Team configuration not persisted: %+v", dev)
	}
	reviewer, err := svc.GetParticipantRecord(ctx, created.Participants["max"])
	if err != nil {
		t.Fatal(err)
	}
	if reviewer.Agent != "codex" || reviewer.AgentID != "agent-review" ||
		reviewer.Role != "Reviewer" || reviewer.Handle != "max" {
		t.Fatalf("wrong reviewer: %+v", reviewer)
	}
	encoded, err := json.Marshal(dev)
	if err != nil {
		t.Fatal(err)
	}
	var exposed map[string]any
	if err := json.Unmarshal(encoded, &exposed); err != nil {
		t.Fatal(err)
	}
	if exposed["role"] != "Developer" || exposed["agentId"] != "agent-dev" {
		t.Fatalf("incorrect UI JSON contract: %s", encoded)
	}
	lease, err := svc.BeginTurn(ctx, created.Participants["alex"], TriggerHuman, "test", "bootstrap",
		agent.Binary{Kind: agent.Codex, Path: "/bin/true"})
	if err != nil {
		t.Fatal(err)
	}
	principal, err := svc.Authenticate(ctx, lease.Token)
	if err != nil {
		t.Fatal(err)
	}
	if principal.AgentID != "agent-dev" || principal.AgentName != "Alex" ||
		principal.Agent != "codex" || principal.Handle != "alex" {
		t.Fatalf("MCP identity lost: %+v", principal)
	}
	view, err := svc.GetObjective(ctx, principal)
	if err != nil {
		t.Fatal(err)
	}
	if view.You.AgentID != "agent-dev" || view.You.Name != "Alex" || len(view.Participants) != 2 {
		t.Fatalf("objective identity lost: %+v", view)
	}
	if err := svc.FinishTurn(ctx, lease.TurnID, TurnOutcome{}); err != nil {
		t.Fatal(err)
	}
}

func TestTeamAgentAssignmentsRejectDuplicates(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "dups.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	svc := New(db)
	project, err := svc.CreateProject(ctx, "test", "")
	if err != nil {
		t.Fatal(err)
	}
	knowledge := t.TempDir()
	base := ParticipantInput{Agent: "claude", AgentID: "team-1", Name: "One",
		Handle: "one", Role: "Developer", KnowledgeRoot: knowledge, Workdir: t.TempDir()}
	for _, other := range []ParticipantInput{
		{Agent: "codex", AgentID: "team-1", Name: "Other", Handle: "two",
			Role: "Reviewer", KnowledgeRoot: knowledge, Workdir: t.TempDir()},
		{Agent: "claude", AgentID: "team-2", Name: "Other", Handle: "one",
			Role: "Reviewer", KnowledgeRoot: knowledge, Workdir: t.TempDir()},
		{Agent: "claude", AgentID: "team-2", Name: "Other", Handle: "human",
			Role: "Reviewer", KnowledgeRoot: knowledge, Workdir: t.TempDir()},
	} {
		_, err := svc.CreateObjective(ctx, ObjectiveInput{
			ProjectID: project.ID, Title: "invalid assignment",
			Participants: []ParticipantInput{base, other},
		})
		if !errors.Is(err, ErrInvalidArgument) {
			t.Fatalf("expected rejected identity/handle: %v", err)
		}
	}
}
