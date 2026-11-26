// Package coretest provisions a real core.Service over a temporary SQLite
// database for end-to-end tests (MCP handler, adapters). It uses only the
// public trusted API, so tests exercise the same paths production does.
package coretest

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/anvh2/agentic-engineering/app/internal/agent"
	"github.com/anvh2/agentic-engineering/app/internal/core"
	"github.com/anvh2/agentic-engineering/app/internal/storage"
)

// Fixture is one project with two objectives. Main has a Claude reviewer and
// a Codex developer and two open tasks; Other is an unrelated objective used
// to prove scope isolation.
type Fixture struct {
	Service *core.Service
	Main    core.ObjectiveRecord
	Other   core.ObjectiveRecord
	// Participant ids in Main.
	Claude, Codex string
	// Participant id in Other.
	Outsider string
}

// Handles in Main.
const (
	ClaudeHandle = "claude-reviewer"
	CodexHandle  = "codex-developer"
)

// New provisions the fixture. The database is closed when the test ends.
func New(t testing.TB) *Fixture {
	t.Helper()
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "v2.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	svc := core.New(db)
	prj, err := svc.CreateProject(ctx, "fixture", "")
	if err != nil {
		t.Fatal(err)
	}
	wd := t.TempDir()
	main, err := svc.CreateObjective(ctx, core.ObjectiveInput{
		ProjectID: prj.ID, Title: "fixture objective", AcceptanceCriteria: "messages flow",
		Participants: []core.ParticipantInput{{Agent: "claude", Role: "Reviewer", Workdir: wd}, {Agent: "codex", Role: "Developer", Workdir: wd}},
		Tasks:        []core.TaskInput{{Title: "first"}, {Title: "second"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	other, err := svc.CreateObjective(ctx, core.ObjectiveInput{
		ProjectID: prj.ID, Title: "unrelated objective",
		Participants: []core.ParticipantInput{{Agent: "claude", Role: "Developer", Workdir: wd}},
		Tasks:        []core.TaskInput{{Title: "foreign"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return &Fixture{Service: svc, Main: main, Other: other,
		Claude: main.Participants[ClaudeHandle], Codex: main.Participants[CodexHandle], Outsider: other.Participants["claude-developer"]}
}

// StartTurn begins a running turn for a participant and returns its lease;
// lease.Token is a valid bearer token until EndTurn.
func (f *Fixture) StartTurn(t testing.TB, participantID string) core.TurnLease {
	t.Helper()
	l, err := f.Service.BeginTurn(context.Background(), participantID, core.TriggerHuman, "test turn", "test bootstrap", agent.Binary{})
	if err != nil {
		t.Fatal(err)
	}
	return l
}

// EndTurn finishes the turn, which revokes its token.
func (f *Fixture) EndTurn(t testing.TB, l core.TurnLease) {
	t.Helper()
	if err := f.Service.FinishTurn(context.Background(), l.TurnID, core.TurnOutcome{}); err != nil {
		t.Fatal(err)
	}
}
