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
		if err != nil {
			t.Fatal(err)
		}
		n := 0
		for _, p := range pending {
			if p.ID == f.claude {
				n++
			}
		}
		if n != want {
			t.Fatalf("pending wake count = %d, want %d", n, want)
		}
	}
	check(0)
	_, err := f.svc.PostHumanMessage(ctx, f.obj.ID, "claude-reviewer", "first", "human-1")
	if err != nil {
		t.Fatal(err)
	}
	check(1)
	wake, err := f.svc.BeginTurn(ctx, f.claude, TriggerWake, "read_messages", "", agent.Binary{Kind: agent.Claude})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.svc.FinishTurn(ctx, wake.TurnID, TurnOutcome{
		Result: agent.TurnResult{NativeSessionID: wake.NativeSessionID},
	}); err != nil {
		t.Fatal(err)
	}
	check(0)
	_, err = f.svc.PostHumanMessage(ctx, f.obj.ID, "claude-reviewer", "second", "human-2")
	if err != nil {
		t.Fatal(err)
	}
	check(1)
	wake, err = f.svc.BeginTurn(ctx, f.claude, TriggerWake, "read_messages", "", agent.Binary{Kind: agent.Claude})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.svc.FinishTurn(ctx, wake.TurnID, TurnOutcome{
		Result: agent.TurnResult{NativeSessionID: wake.NativeSessionID},
	}); err != nil {
		t.Fatal(err)
	}
	_, err = f.svc.PostHumanMessage(ctx, f.obj.ID, "claude-reviewer", "third", "human-3")
	if err != nil {
		t.Fatal(err)
	}
	check(0) // budget exhausted, no automatic notification
	if _, err := f.svc.BeginTurn(ctx, f.claude, TriggerWake, "wake", "", agent.Binary{}); !errors.Is(err, ErrWakeBudgetExhausted) {
		t.Fatalf("wake exceeded budget: %v", err)
	}
}

// A turn whose collaboration calls all failed is reported by the adapter as a
// native error; a recovered failure, such as a stale revision, is not.
func TestCollaborationFailureClassification(t *testing.T) {
	for _, tc := range []struct {
		name   string
		result agent.TurnResult
		want   string
	}{
		{"unavailable tools", agent.TurnResult{NativeSessionID: "thread", ToolFailures: 1,
			NativeError: agent.ErrCollaborationUnavailable}, "failed"},
		{"recovered failure", agent.TurnResult{NativeSessionID: "thread", ToolFailures: 1}, "succeeded"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			ctx := context.Background()
			_, lease := f.principal(f.codex)
			if err := f.svc.FinishTurn(ctx, lease.TurnID, TurnOutcome{Result: tc.result}); err != nil {
				t.Fatal(err)
			}
			var state string
			var failures int
			if err := f.svc.db.QueryRowContext(ctx,
				`SELECT state, tool_failures FROM turns WHERE id = ?`, lease.TurnID).Scan(&state, &failures); err != nil {
				t.Fatal(err)
			}
			if state != tc.want || failures != 1 {
				t.Fatalf("turn recorded as %s with %d failures", state, failures)
			}
			if _, err := f.svc.Authenticate(ctx, lease.Token); !errors.Is(err, ErrUnauthenticated) {
				t.Fatal("credential not revoked for finished turn")
			}
		})
	}
}
