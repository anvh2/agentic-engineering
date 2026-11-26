package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/anvh2/agentic-engineering/app/internal/agent"
	"github.com/anvh2/agentic-engineering/app/internal/storage"
)

type fixture struct {
	t      *testing.T
	svc    *Service
	path   string
	obj    ObjectiveRecord
	other  ObjectiveRecord
	claude string // participant ids
	codex  string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "v2.db")
	db, err := storage.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	f := &fixture{t: t, svc: New(db), path: path}
	prj, err := f.svc.CreateProject(ctx, "Agentic Engineering", "")
	if err != nil {
		t.Fatal(err)
	}
	wd := t.TempDir()
	f.obj, err = f.svc.CreateObjective(ctx, ObjectiveInput{
		ProjectID: prj.ID, Title: "M1 slice", AcceptanceCriteria: "messages flow",
		Participants: []ParticipantInput{{Agent: "claude", Role: "Reviewer", Workdir: wd}, {Agent: "codex", Role: "Developer", Workdir: wd}},
		Tasks:        []TaskInput{{Title: "storage"}, {Title: "mcp"}},
		WakeBudget:   2,
	})
	if err != nil {
		t.Fatal(err)
	}
	f.other, err = f.svc.CreateObjective(ctx, ObjectiveInput{
		ProjectID: prj.ID, Title: "unrelated",
		Participants: []ParticipantInput{{Agent: "claude", Role: "Developer", Workdir: wd}},
		Tasks:        []TaskInput{{Title: "secret"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	f.claude = f.obj.Participants["claude-reviewer"]
	f.codex = f.obj.Participants["codex-developer"]
	return f
}

// principal starts a real turn and authenticates its token, the same path MCP uses.
func (f *fixture) principal(participantID string) (Principal, TurnLease) {
	f.t.Helper()
	ctx := context.Background()
	l, err := f.svc.BeginTurn(ctx, participantID, TriggerStart, "start", "bootstrap", agent.Binary{})
	if err != nil {
		f.t.Fatal(err)
	}
	p, err := f.svc.Authenticate(ctx, l.Token)
	if err != nil {
		f.t.Fatal(err)
	}
	return p, l
}

func TestParticipantHandlesAndObjectiveView(t *testing.T) {
	f := newFixture(t)
	p, _ := f.principal(f.codex)
	v, err := f.svc.GetObjective(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	if v.You.Handle != "codex-developer" || len(v.Participants) != 2 || len(v.Tasks) != 2 || v.ID != f.obj.ID {
		t.Fatalf("unexpected view: %+v", v)
	}
}

func TestFailedObjectiveCreationLeavesNothing(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	if _, err := f.svc.CreateObjective(ctx, ObjectiveInput{ProjectID: "prj_missing", Title: "bad",
		Participants: []ParticipantInput{{Agent: "claude", Role: "A", Workdir: "/tmp"}}}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown project: want not found, got %v", err)
	}
	var projectID string
	f.svc.db.QueryRow(`SELECT id FROM projects LIMIT 1`).Scan(&projectID)
	_, err := f.svc.CreateObjective(ctx, ObjectiveInput{ProjectID: projectID, Title: "bad",
		Participants: []ParticipantInput{{Agent: "claude", Role: "A", Workdir: "/tmp"}, {Agent: "gemini", Role: "B", Workdir: "/tmp"}}})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("want invalid argument, got %v", err)
	}
	var n int
	f.svc.db.QueryRow(`SELECT COUNT(*) FROM objectives WHERE title = 'bad'`).Scan(&n)
	if n != 0 {
		t.Fatalf("partial objective persisted")
	}
}

func TestSendIsIdempotentAndConflictsOnDifferentContent(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	p, _ := f.principal(f.claude)
	in := SendMessageInput{To: "codex-developer", Body: "hello", IdempotencyKey: "k1"}
	a, err := f.svc.SendMessage(ctx, p, in)
	if err != nil {
		t.Fatal(err)
	}
	b, err := f.svc.SendMessage(ctx, p, in)
	if err != nil || b.ID != a.ID || b.Seq != a.Seq || !b.CreatedAt.Equal(a.CreatedAt) {
		t.Fatalf("replay must return the original: %v %+v %+v", err, a, b)
	}
	in.Body = "different"
	if _, err := f.svc.SendMessage(ctx, p, in); !errors.Is(err, ErrConflict) {
		t.Fatalf("want conflict, got %v", err)
	}
	var n int
	f.svc.db.QueryRow(`SELECT COUNT(*) FROM messages`).Scan(&n)
	if n != 1 {
		t.Fatalf("want 1 row, got %d", n)
	}
}

func TestSendValidation(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	p, _ := f.principal(f.claude)
	cases := []SendMessageInput{
		{To: "codex-developer", Body: "", IdempotencyKey: "a"},
		{To: "codex-developer", Body: "x", IdempotencyKey: ""},
		{To: "claude-reviewer", Body: "x", IdempotencyKey: "b"},
		{To: "codex-developer", Body: string(make([]byte, MaxMessageBytes+1)), IdempotencyKey: "c"},
		{To: "codex-developer", Body: "\xff", IdempotencyKey: "d"},
	}
	for i, c := range cases {
		if _, err := f.svc.SendMessage(ctx, p, c); !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("case %d: want invalid argument, got %v", i, err)
		}
	}
	// A participant of another objective is not addressable and not revealed.
	if _, err := f.svc.SendMessage(ctx, p, SendMessageInput{To: "claude-developer", Body: "x", IdempotencyKey: "e"}); !errors.Is(err, ErrNotFound) {
		t.Errorf("foreign recipient: want not found, got %v", err)
	}
}

func TestReadMessagesScopeOrderCursorAndPaging(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	pc, _ := f.principal(f.claude)
	px, _ := f.principal(f.codex)
	for i := 0; i < 3; i++ {
		if _, err := f.svc.SendMessage(ctx, pc, SendMessageInput{To: "codex-developer", Body: fmt.Sprint("m", i), IdempotencyKey: fmt.Sprint("k", i)}); err != nil {
			t.Fatal(err)
		}
	}
	f.svc.SendMessage(ctx, pc, SendMessageInput{To: "", Body: "broadcast", IdempotencyKey: "b"})
	f.svc.SendMessage(ctx, px, SendMessageInput{To: "claude-reviewer", Body: "own", IdempotencyKey: "o"})
	f.svc.PostHumanMessage(ctx, f.obj.ID, "codex-developer", "from director", "")
	f.svc.PostHumanMessage(ctx, f.other.ID, "", "other objective", "")

	page, err := f.svc.ReadMessages(ctx, px, AfterUnread, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Messages) != 2 || !page.HasMore || page.Messages[0].Body != "m0" || page.Messages[1].Body != "m1" {
		t.Fatalf("first page: %+v", page)
	}
	page, _ = f.svc.ReadMessages(ctx, px, AfterUnread, 10)
	var bodies []string
	for _, m := range page.Messages {
		bodies = append(bodies, m.Body)
	}
	if fmt.Sprint(bodies) != "[m2 broadcast from director]" || page.HasMore {
		t.Fatalf("second page: %v has_more=%v", bodies, page.HasMore)
	}
	page, _ = f.svc.ReadMessages(ctx, px, AfterUnread, 10)
	if len(page.Messages) != 0 {
		t.Fatalf("cursor did not advance: %+v", page)
	}
	// An explicit cursor rereads without needing state; reading is non-destructive.
	page, _ = f.svc.ReadMessages(ctx, px, 0, 10)
	if len(page.Messages) != 5 {
		t.Fatalf("explicit reread: got %d", len(page.Messages))
	}
	if _, err := f.svc.ReadMessages(ctx, px, -2, 10); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("want invalid after, got %v", err)
	}
}

func TestConcurrentClaimsHaveExactlyOneWinner(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	pc, _ := f.principal(f.claude)
	px, _ := f.principal(f.codex)
	task := f.obj.Tasks[0]
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins, conflicts := map[string]int{}, 0
	for i := 0; i < 16; i++ {
		p := pc
		if i%2 == 1 {
			p = px
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := f.svc.ClaimTask(ctx, p, task.ID, task.Revision)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				wins[got.Owner]++
			case errors.Is(err, ErrConflict):
				conflicts++
			default:
				t.Errorf("unexpected error: %v", err)
			}
		}()
	}
	wg.Wait()
	if len(wins) != 1 || conflicts != 15 {
		t.Fatalf("wins=%v conflicts=%d", wins, conflicts)
	}
}

func TestTaskOwnershipRules(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	pc, _ := f.principal(f.claude)
	px, _ := f.principal(f.codex)
	task := f.obj.Tasks[1]
	claimed, err := f.svc.ClaimTask(ctx, px, task.ID, 1)
	if err != nil || claimed.Revision != 2 || claimed.Status != TaskInProgress || claimed.Owner != "codex-developer" {
		t.Fatalf("claim: %v %+v", err, claimed)
	}
	if _, err := f.svc.UpdateTask(ctx, pc, UpdateTaskInput{TaskID: task.ID, ExpectedRevision: 2, Status: TaskBlocked}); !errors.Is(err, ErrConflict) {
		t.Fatalf("non-owner update: %v", err)
	}
	if _, err := f.svc.UpdateTask(ctx, px, UpdateTaskInput{TaskID: task.ID, ExpectedRevision: 1, Status: TaskBlocked}); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale revision: %v", err)
	}
	if _, err := f.svc.UpdateTask(ctx, px, UpdateTaskInput{TaskID: task.ID, ExpectedRevision: 2, Status: TaskAccepted}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("agent accept: %v", err)
	}
	sub, err := f.svc.UpdateTask(ctx, px, UpdateTaskInput{TaskID: task.ID, ExpectedRevision: 2, Status: TaskSubmitted, Summary: "done, see branch"})
	if err != nil || sub.Revision != 3 {
		t.Fatalf("submit: %v %+v", err, sub)
	}
	acc, err := f.svc.SetTaskVerdict(ctx, f.obj.ID, task.ID, 3, true, "verified")
	if err != nil || acc.Status != TaskAccepted {
		t.Fatalf("verdict: %v %+v", err, acc)
	}
	if _, err := f.svc.UpdateTask(ctx, px, UpdateTaskInput{TaskID: task.ID, ExpectedRevision: 4, Status: TaskInProgress}); !errors.Is(err, ErrConflict) {
		t.Fatalf("accepted is terminal: %v", err)
	}
	// Release returns a task to the pool.
	t0 := f.obj.Tasks[0]
	f.svc.ClaimTask(ctx, pc, t0.ID, 1)
	rel, err := f.svc.UpdateTask(ctx, pc, UpdateTaskInput{TaskID: t0.ID, ExpectedRevision: 2, Status: TaskOpen})
	if err != nil || rel.Owner != "" || rel.Status != TaskOpen {
		t.Fatalf("release: %v %+v", err, rel)
	}
}

func TestForeignObjectiveTaskIsNotFound(t *testing.T) {
	f := newFixture(t)
	p, _ := f.principal(f.claude)
	foreign := f.other.Tasks[0]
	if _, err := f.svc.ClaimTask(context.Background(), p, foreign.ID, 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want not found, got %v", err)
	}
}

func TestTokenLifecycle(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	for _, bad := range []string{"", "garbage", "aet_unknown"} {
		if _, err := f.svc.Authenticate(ctx, bad); !errors.Is(err, ErrUnauthenticated) {
			t.Fatalf("%q: %v", bad, err)
		}
	}
	_, l := f.principal(f.claude)
	if l.NativeSessionID == "" || !l.NewSession || l.Instructions != "bootstrap" {
		t.Fatalf("claude session must pre-assign a native id: %+v", l)
	}
	var stored int
	f.svc.db.QueryRow(`SELECT COUNT(*) FROM turn_tokens WHERE token_sha256 = ?`, l.Token).Scan(&stored)
	if stored != 0 {
		t.Fatal("plaintext token persisted")
	}
	if err := f.svc.FinishTurn(ctx, l.TurnID, TurnOutcome{}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Authenticate(ctx, l.Token); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("finished turn token must be revoked: %v", err)
	}
	// Expiry is enforced even if a turn is never finished.
	_, l2 := f.principal(f.codex)
	f.svc.SetClock(func() time.Time { return time.Now().UTC().Add(MaxTurnDuration + time.Minute) })
	if _, err := f.svc.Authenticate(ctx, l2.Token); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("expired token accepted: %v", err)
	}
}

func TestSingleFlightResumeAndRecovery(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	_, l := f.principal(f.codex)
	if _, err := f.svc.BeginTurn(ctx, f.codex, TriggerHuman, "again", "", agent.Binary{}); !errors.Is(err, ErrConflict) {
		t.Fatalf("second concurrent turn: %v", err)
	}
	if err := f.svc.RecordNativeSessionID(ctx, l.TurnID, "thread-1"); err != nil {
		t.Fatal(err)
	}
	n, err := f.svc.RecoverInterrupted(ctx)
	if err != nil || n != 1 {
		t.Fatalf("recover: %d %v", n, err)
	}
	if _, err := f.svc.Authenticate(ctx, l.Token); !errors.Is(err, ErrUnauthenticated) {
		t.Fatal("interrupted turn token still valid")
	}
	if err := f.svc.FinishTurn(ctx, l.TurnID, TurnOutcome{}); !errors.Is(err, ErrConflict) {
		t.Fatalf("late result for interrupted turn must be rejected: %v", err)
	}
	// The next turn resumes the same native session without re-injecting context.
	l2, err := f.svc.BeginTurn(ctx, f.codex, TriggerHuman, "continue", "NEW BOOTSTRAP", agent.Binary{})
	if err != nil || l2.NewSession || l2.NativeSessionID != "thread-1" || l2.SessionID != l.SessionID || l2.Instructions != "" {
		t.Fatalf("resume lease: %v %+v", err, l2)
	}
	if err := f.svc.RecordNativeSessionID(ctx, l2.TurnID, "thread-2"); !errors.Is(err, ErrConflict) {
		t.Fatalf("native id must not be silently replaced: %v", err)
	}
}

func TestWakeBudget(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		l, err := f.svc.BeginTurn(ctx, f.claude, TriggerWake, "wake", "", agent.Binary{})
		if err != nil {
			t.Fatal(err)
		}
		f.svc.FinishTurn(ctx, l.TurnID, TurnOutcome{})
	}
	if _, err := f.svc.BeginTurn(ctx, f.claude, TriggerWake, "wake", "", agent.Binary{}); !errors.Is(err, ErrWakeBudgetExhausted) {
		t.Fatalf("want budget exhausted, got %v", err)
	}
	// Human-triggered turns are not automatic and do not consume the budget.
	if _, err := f.svc.BeginTurn(ctx, f.claude, TriggerHuman, "director", "", agent.Binary{}); err != nil {
		t.Fatal(err)
	}
}

func TestUsageRecordedOnceWithUnknownsPreserved(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	_, l := f.principal(f.codex)
	i := func(v int64) *int64 { return &v }
	u := agent.Usage{Provider: agent.Codex, Model: "m", UncachedInput: i(8149), CacheRead: i(55552), CacheWrite: i(0), Output: i(124), NormalizationVersion: 1, Raw: json.RawMessage(`{"input_tokens":63701}`)}
	res := agent.TurnResult{Usage: []agent.Usage{u, u}, NativeSessionID: "t"}
	if err := f.svc.FinishTurn(ctx, l.TurnID, TurnOutcome{Result: res}); err != nil {
		t.Fatal(err)
	}
	var n int
	var reasoning, cost any
	var kind string
	f.svc.db.QueryRow(`SELECT COUNT(*), MAX(reasoning), MAX(cost_usd_estimate), MAX(cost_kind) FROM usage_records`).Scan(&n, &reasoning, &cost, &kind)
	if n != 1 || reasoning != nil || cost != nil || kind != "unknown" {
		t.Fatalf("usage rows=%d reasoning=%v cost=%v kind=%s", n, reasoning, cost, kind)
	}
}

func TestReopenPreservesOrderingAndCursor(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	pc, lc := f.principal(f.claude)
	px, lx := f.principal(f.codex)
	f.svc.SendMessage(ctx, pc, SendMessageInput{To: "codex-developer", Body: "one", IdempotencyKey: "1"})
	f.svc.SendMessage(ctx, pc, SendMessageInput{To: "codex-developer", Body: "two", IdempotencyKey: "2"})
	f.svc.ReadMessages(ctx, px, AfterUnread, 1)
	_ = lc
	f.svc.db.Close()

	db, err := storage.Open(ctx, f.path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	svc := New(db)
	if n, _ := svc.RecoverInterrupted(ctx); n != 2 {
		t.Fatalf("expected both running turns interrupted, got %d", n)
	}
	l, err := svc.BeginTurn(ctx, f.codex, TriggerHuman, "resume", "", agent.Binary{})
	if err != nil || l.SessionID != lx.SessionID {
		t.Fatalf("resume after reopen: %v", err)
	}
	p, _ := svc.Authenticate(ctx, l.Token)
	page, err := svc.ReadMessages(ctx, p, AfterUnread, 10)
	if err != nil || len(page.Messages) != 1 || page.Messages[0].Body != "two" {
		t.Fatalf("after reopen: %v %+v", err, page)
	}
	c, _ := svc.SendMessage(ctx, p, SendMessageInput{To: "claude-reviewer", Body: "three", IdempotencyKey: "3"})
	if c.Seq <= page.Messages[0].Seq {
		t.Fatalf("sequence went backwards: %d <= %d", c.Seq, page.Messages[0].Seq)
	}
}

// A principal authenticated at HTTP admission must not be able to write once
// its turn has ended (finished, cancelled or interrupted by restart).
func TestMutationsRevalidateTheLiveTurn(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	p, l := f.principal(f.codex)
	task := f.obj.Tasks[0]
	if err := f.svc.FinishTurn(ctx, l.TurnID, TurnOutcome{Result: agent.TurnResult{Interrupted: true}}); err != nil {
		t.Fatal(err)
	}
	checks := map[string]error{}
	_, checks["send"] = f.svc.SendMessage(ctx, p, SendMessageInput{To: "claude-reviewer", Body: "late", IdempotencyKey: "late"})
	_, checks["read"] = f.svc.ReadMessages(ctx, p, AfterUnread, 10)
	_, checks["claim"] = f.svc.ClaimTask(ctx, p, task.ID, task.Revision)
	_, checks["update"] = f.svc.UpdateTask(ctx, p, UpdateTaskInput{TaskID: task.ID, ExpectedRevision: 1, Status: TaskBlocked})
	for name, err := range checks {
		if !errors.Is(err, ErrUnauthenticated) {
			t.Errorf("%s after turn end: want ErrUnauthenticated, got %v", name, err)
		}
	}
	var n int
	f.svc.db.QueryRow(`SELECT COUNT(*) FROM messages`).Scan(&n)
	if n != 0 {
		t.Fatal("stale write persisted")
	}
}
