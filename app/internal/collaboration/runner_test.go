package collaboration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/anvh2/agentic-engineering/app/internal/agent"
	"github.com/anvh2/agentic-engineering/app/internal/core"
)

type probeAdapter struct {
	kind    agent.Kind
	started chan agent.TurnSpec
	release chan struct{}
}

func (a *probeAdapter) Kind() agent.Kind { return a.kind }

func (a *probeAdapter) Run(ctx context.Context, spec agent.TurnSpec, emit func(agent.Event)) (agent.TurnResult, error) {
	if a.started != nil {
		a.started <- spec
	}
	if a.release != nil {
		select {
		case <-ctx.Done():
			return agent.TurnResult{Interrupted: true}, nil
		case <-a.release:
		}
	}
	emit(agent.Event{Seq: 1, Type: "synthetic", Raw: json.RawMessage(`{"type":"synthetic","ok":true}`)})
	native := spec.NativeSessionID
	if native == "" {
		native = spec.NewSessionID
	}
	if native == "" {
		native = "codex-synthetic-id"
	}
	return agent.TurnResult{NativeSessionID: native, FinalText: "Test evidence", ExitCode: 0}, nil
}

func setupRunner(t *testing.T, kind agent.Kind, wakeBudget int) (*Runner, string) {
	t.Helper()
	ctx := context.Background()
	base := t.TempDir()
	r, err := Open(ctx, filepath.Join(base, "m1.sqlite"), filepath.Join(base, "evidence"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := r.Close(closeCtx); err != nil {
			t.Errorf("close runner: %v", err)
		}
	})
	project, err := r.Service().CreateProject(ctx, "fixture", "")
	if err != nil {
		t.Fatal(err)
	}
	role := "Developer"
	if kind == agent.Claude {
		role = "Reviewer"
	}
	objective, err := r.Service().CreateObjective(ctx, core.ObjectiveInput{
		ProjectID: project.ID, Title: "M1 real socket", AcceptanceCriteria: "durable evidence",
		Participants: []core.ParticipantInput{{Agent: string(kind), Role: role, Workdir: t.TempDir()}},
		Tasks:        []core.TaskInput{{Title: "complete test task"}}, WakeBudget: wakeBudget,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range objective.Participants {
		return r, id
	}
	t.Fatal("no participant")
	return nil, ""
}

func TestTurnEvidenceDurabilityAndSessionContinuity(t *testing.T) {
	ctx := context.Background()
	r, participant := setupRunner(t, agent.Claude, 0)
	r.agents[agent.Claude] = &probeAdapter{kind: agent.Claude}
	binary := agent.Binary{Kind: agent.Claude, Path: "/bin/true", Version: "fixture"}
	first, err := r.RunTurn(ctx, turn(participant, "first", "approved bootstrap", binary))
	if err != nil || first.State != "succeeded" || first.EvidencePath == "" || first.EvidenceSHA256 == "" {
		t.Fatalf("first turn: %+v %v", first, err)
	}
	bytes, err := io.ReadAll(mustOpen(t, first.EvidencePath))
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(bytes)
	if hex.EncodeToString(hash[:]) != first.EvidenceSHA256 {
		t.Fatal("persisted event bytes do not match SHA-256 evidence")
	}
	second, err := r.RunTurn(ctx, turn(participant, "second", "should not reinject", binary))
	if err != nil || second.State != "succeeded" || second.SessionID != first.SessionID ||
		second.NativeSessionID != first.NativeSessionID {
		t.Fatalf("resume continuity: %+v %+v %v", first, second, err)
	}
}

func turn(participant, prompt, instructions string, binary agent.Binary) TurnRequest {
	return TurnRequest{ParticipantID: participant, Trigger: core.TriggerHuman, Prompt: prompt,
		Instructions: instructions, Binary: binary}
}

func mustOpen(t *testing.T, path string) io.ReadCloser {
	t.Helper()
	file, err := openEvidence(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = file.Close() })
	return file
}

func openEvidence(path string) (io.ReadCloser, error) {
	return os.Open(path)
}

func TestRealSocketAuthenticationSingleFlightAndRevocation(t *testing.T) {
	ctx := context.Background()
	r, participant := setupRunner(t, agent.Codex, 0)
	probe := &probeAdapter{kind: agent.Codex, started: make(chan agent.TurnSpec, 1), release: make(chan struct{})}
	r.agents[agent.Codex] = probe
	binary := agent.Binary{Kind: agent.Codex, Path: "/bin/true", Version: "fixture"}
	type outcome struct {
		report TurnReport
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		report, err := r.RunTurn(ctx, turn(participant, "test socket", "bootstrap", binary))
		done <- outcome{report, err}
	}()
	var spec agent.TurnSpec
	select {
	case spec = <-probe.started:
	case <-time.After(3 * time.Second):
		t.Fatal("turn did not start")
	}
	if _, err := r.RunTurn(ctx, turn(participant, "concurrent", "", binary)); err == nil {
		t.Fatal("participant accepted a concurrent turn")
	}
	call := func(token string, method string) int {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method,
			"params": map[string]any{"protocolVersion": "2025-06-18",
				"capabilities": map[string]any{}, "clientInfo": map[string]string{"name": "fixture", "version": "1"}}})
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.MCPURL(), bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		return resp.StatusCode
	}
	if code := call("wrong-token", "initialize"); code != 401 {
		t.Fatalf("unauthorized socket: %d", code)
	}
	if code := call(spec.Token, "initialize"); code != 200 {
		t.Fatalf("authorized socket: %d", code)
	}
	close(probe.release)
	select {
	case finished := <-done:
		if finished.err != nil || finished.report.State != "succeeded" {
			t.Fatalf("turn failed: %+v %v", finished.report, finished.err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("turn did not finish")
	}
	if code := call(spec.Token, "initialize"); code != 401 {
		t.Fatalf("revoked token accepted: %d", code)
	}
}

func TestCancellationRevokesTurn(t *testing.T) {
	ctx := context.Background()
	r, participant := setupRunner(t, agent.Codex, 0)
	probe := &probeAdapter{kind: agent.Codex, started: make(chan agent.TurnSpec, 1), release: make(chan struct{})}
	r.agents[agent.Codex] = probe
	finished := make(chan TurnReport, 1)
	go func() {
		report, _ := r.RunTurn(ctx, turn(participant, "cancel me", "bootstrap",
			agent.Binary{Kind: agent.Codex, Path: "/bin/true"}))
		finished <- report
	}()
	spec := <-probe.started
	r.Cancel(participant)
	select {
	case report := <-finished:
		if report.State != "interrupted" {
			t.Fatalf("cancelled turn was not interrupted: %+v", report)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancel did not finish")
	}
	if _, err := r.Service().Authenticate(ctx, spec.Token); !errors.Is(err, core.ErrUnauthenticated) {
		t.Fatalf("cancelled credential remains valid: %v", err)
	}
}
