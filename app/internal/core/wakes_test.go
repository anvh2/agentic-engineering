package core

import (
	"context"
	"errors"
	"testing"

	"github.com/anvh2/agentic-engineering/app/internal/agent"
)

func TestWakeCursorAndBudgetStayDurable(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	_, initial := f.principal(f.claude)
	if err := f.svc.FinishTurn(ctx, initial.TurnID, TurnOutcome{
		Result: agent.TurnResult{NativeSessionID: initial.NativeSessionID},
	}); err != nil {
		t.Fatal(err)
	}
	check := func(want int) {
		t.Helper()
		pending, err := f.svc.PendingWakeParticipants(ctx, 8)
		if err != nil { t.Fatal(err) }
		n := 0
		for _, p := range pending { if p.ID == f.claude { n++ } }
		if n != want { t.Fatalf("pending wake count = %d, want %d",n,want) }
	}
	check(0)
	_, err := f.svc.PostHumanMessage(ctx, f.obj.ID, "claude-reviewer", "first", "human-1")
	if err != nil { t.Fatal(err) }
	check(1)
	wake, err := f.svc.BeginTurn(ctx, f.claude, TriggerWake, "read_messages", "", agent.Binary{Kind:agent.Claude})
	if err != nil { t.Fatal(err) }
	if err := f.svc.FinishTurn(ctx, wake.TurnID, TurnOutcome{
		Result: agent.TurnResult{NativeSessionID: wake.NativeSessionID},
	}); err != nil { t.Fatal(err) }
	check(0)
	_, err = f.svc.PostHumanMessage(ctx, f.obj.ID, "claude-reviewer", "second", "human-2")
	if err != nil { t.Fatal(err) }
	check(1)
	wake, err = f.svc.BeginTurn(ctx, f.claude, TriggerWake, "read_messages", "", agent.Binary{Kind:agent.Claude})
	if err != nil { t.Fatal(err) }
	if err := f.svc.FinishTurn(ctx, wake.TurnID, TurnOutcome{
		Result: agent.TurnResult{NativeSessionID: wake.NativeSessionID},
	}); err != nil { t.Fatal(err) }
	_, err = f.svc.PostHumanMessage(ctx, f.obj.ID, "claude-reviewer", "third", "human-3")
	if err != nil { t.Fatal(err) }
	check(0) // budget exhausted, no automatic notification
	if _, err := f.svc.BeginTurn(ctx, f.claude, TriggerWake, "wake", "", agent.Binary{}); !errors.Is(err,ErrWakeBudgetExhausted) {
		t.Fatalf("wake exceeded budget: %v",err)
	}
}

func TestMCPToolFailurePersistsAsFailedTurn(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	_, lease := f.principal(f.codex)
	if err := f.svc.FinishTurn(ctx, lease.TurnID, TurnOutcome{
		Result: agent.TurnResult{NativeSessionID:"thread",ToolFailures:1,ExitCode:0},
	}); err != nil { t.Fatal(err) }
	var state string
	if err := f.svc.db.QueryRowContext(ctx,
		`SELECT state FROM turns WHERE id = ?`, lease.TurnID).Scan(&state); err != nil { t.Fatal(err) }
	if state != "failed" { t.Fatalf("failed MCP call recorded as %s",state) }
	if _, err := f.svc.Authenticate(ctx, lease.Token); !errors.Is(err, ErrUnauthenticated) {
		t.Fatal("credential not revoked for failed turn")
	}
}
