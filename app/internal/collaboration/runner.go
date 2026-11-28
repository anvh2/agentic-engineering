// Package collaboration connects the durable core, authenticated MCP endpoint
// and native agent adapters. It owns every subprocess and evidence file.
package collaboration

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/anvh2/agentic-engineering/app/internal/agent"
	"github.com/anvh2/agentic-engineering/app/internal/core"
	"github.com/anvh2/agentic-engineering/app/internal/discovery"
	"github.com/anvh2/agentic-engineering/app/internal/mcp"
	"github.com/anvh2/agentic-engineering/app/internal/storage"
)

const (
	turnDeadline = 4 * time.Hour
	finishDeadline = 10 * time.Second
)

type Runner struct {
	service *core.Service
	db *sql.DB
	endpoint *mcp.Endpoint
	evidenceDir string
	agents map[agent.Kind]agent.Adapter
	wakeSignal chan struct{}
	wakeCancel context.CancelFunc

	mu sync.Mutex
	active map[string]context.CancelFunc
	closing bool
	wg sync.WaitGroup
}

type TurnReport struct {
	TurnID string `json:"turnId"`
	SessionID string `json:"sessionId"`
	Participant string `json:"participant"`
	Provider string `json:"provider"`
	State string `json:"state"`
	FinalText string `json:"finalText"`
	NativeSessionID string `json:"nativeSessionId"`
	ToolFailures int `json:"toolFailures"`
	Usage []agent.Usage `json:"usage"`
	EvidencePath string `json:"evidencePath"`
	EvidenceSHA256 string `json:"evidenceSha256"`
	Error string `json:"error,omitempty"`
}

func Open(ctx context.Context, dbPath, evidenceDir string) (*Runner, error) {
	if !filepath.IsAbs(dbPath) || !filepath.IsAbs(evidenceDir) {
		return nil, errors.New("collaboration paths must be absolute")
	}
	db, err := storage.Open(ctx, dbPath)
	if err != nil {
		return nil, fmt.Errorf("open collaboration store: %w", err)
	}
	service := core.New(db)
	if _, err := service.RecoverInterrupted(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("recover interrupted turns: %w", err)
	}
	if err := os.MkdirAll(evidenceDir, 0700); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("create evidence directory: %w", err)
	}
	endpoint, err := mcp.Start(service)
	if err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("start MCP listener: %w", err)
	}
	r := &Runner{
		service: service, db: db, endpoint: endpoint, evidenceDir: evidenceDir,
		active: make(map[string]context.CancelFunc),
		wakeSignal: make(chan struct{}, 1),
		agents: map[agent.Kind]agent.Adapter{
			agent.Claude: agent.ClaudeAdapter{},
			agent.Codex: agent.CodexAdapter{},
		},
	}
	wakeCtx, cancel := context.WithCancel(ctx)
	r.wakeCancel = cancel
	service.SetMessageNotifier(func(string) {
		// Coalesce notifications; SQLite is the durable queue of record.
		select {
		case r.wakeSignal <- struct{}{}:
		default:
		}
	})
	r.wg.Add(1)
	go r.wakeLoop(wakeCtx)
	return r, nil
}

func (r *Runner) Service() *core.Service { return r.service }

func (r *Runner) MCPURL() string { return r.endpoint.URL }

func (r *Runner) Cancel(participantID string) {
	r.mu.Lock()
	cancel := r.active[participantID]
	r.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// Close prevents new work, interrupts owned turns, waits for each process to
// exit and revoke its lease, then shuts down the MCP listener and SQLite.
func (r *Runner) Close(ctx context.Context) error {
	r.mu.Lock()
	r.closing = true
	if r.wakeCancel != nil {
		r.wakeCancel()
	}
	for _, cancel := range r.active {
		cancel()
	}
	r.mu.Unlock()
	done := make(chan struct{})
	go func() {
		r.wg.Wait()
		close(done)
	}()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-done:
	}
	err := r.endpoint.Close(ctx)
	if closeErr := r.db.Close(); err == nil {
		err = closeErr
	}
	return err
}

func (r *Runner) RunTurn(ctx context.Context, participantID string, trigger core.Trigger,
	prompt, instructions string, binary agent.Binary, onEvent func(agent.Event)) (TurnReport, error) {
	p, err := r.service.GetParticipantRecord(ctx, participantID)
	if err != nil {
		return TurnReport{}, err
	}
	kind := agent.Kind(p.Agent)
	if kind != binary.Kind || !filepath.IsAbs(binary.Path) {
		return TurnReport{}, errors.New("authenticated provider executable does not match participant")
	}
	adapter := r.agents[kind]
	if adapter == nil {
		return TurnReport{}, errors.New("unsupported agent provider")
	}
	ctx, cancel := context.WithTimeout(ctx, turnDeadline)
	r.mu.Lock()
	if r.closing || r.active[participantID] != nil {
		r.mu.Unlock()
		cancel()
		return TurnReport{}, errors.New("collaboration runtime closed or participant busy")
	}
	r.active[participantID] = cancel
	r.wg.Add(1)
	r.mu.Unlock()
	defer func() {
		cancel()
		r.mu.Lock()
		delete(r.active, participantID)
		r.mu.Unlock()
		r.wg.Done()
	}()

	lease, err := r.service.BeginTurn(ctx, participantID, trigger, prompt, instructions, binary)
	if err != nil {
		return TurnReport{}, err
	}
	report := TurnReport{TurnID: lease.TurnID, SessionID: lease.SessionID,
		Participant: lease.Handle, Provider: p.Agent, State: "failed"}
	spec := agent.TurnSpec{Binary: binary, Workdir: lease.Workdir,
		Prompt: prompt, Instructions: lease.Instructions,
		MCPURL: r.endpoint.URL, Token: lease.Token}
	if lease.NewSession && kind == agent.Claude {
		spec.NewSessionID = lease.NativeSessionID
	} else {
		spec.NativeSessionID = lease.NativeSessionID
	}
	if !lease.NewSession && spec.NativeSessionID == "" {
		// A crash before the first native ID cannot safely resume that
		// process. The core records failure; a replacement session is needed.
		err = errors.New("native session identity unavailable; cannot resume")
	}
	var (
		result agent.TurnResult
		logPath string
		logDigest string
	)
	if err == nil {
		result, logPath, logDigest, err = r.execute(ctx, adapter, spec, lease.TurnID, onEvent)
	}
	outcome := core.TurnOutcome{Result: result, StartErr: err, LogPath: logPath, LogSHA256: logDigest}
	// Finishing must revoke the credential even if the invoking UI operation
	// was cancelled. A bounded shutdown context is intentionally detached.
	finishCtx, finishCancel := context.WithTimeout(context.WithoutCancel(ctx), finishDeadline)
	defer finishCancel()
	if finishErr := r.service.FinishTurn(finishCtx, lease.TurnID, outcome); finishErr != nil {
		return report, fmt.Errorf("persist terminal state for %s: %w", lease.TurnID, finishErr)
	}
	report.FinalText = result.FinalText
	report.NativeSessionID = result.NativeSessionID
	report.ToolFailures = result.ToolFailures
	report.Usage = result.Usage
	report.EvidencePath = logPath
	report.EvidenceSHA256 = logDigest
	if err != nil {
		report.Error = err.Error()
	} else if result.Interrupted {
		report.State = "interrupted"
		report.Error = "turn interrupted"
	} else if result.ExitCode == 0 && result.NativeError == "" && result.ToolFailures == 0 {
		report.State = "succeeded"
	} else {
		report.Error = result.NativeError
		if report.Error == "" {
			report.Error = "native turn failed"
		}
	}
	return report, nil
}

func (r *Runner) execute(ctx context.Context, adapter agent.Adapter, spec agent.TurnSpec,
	turnID string, onEvent func(agent.Event)) (agent.TurnResult, string, string, error) {
	path := filepath.Join(r.evidenceDir, turnID+".jsonl")
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return agent.TurnResult{}, "", "", fmt.Errorf("create turn evidence: %w", err)
	}
	digest := sha256.New()
	writer := io.MultiWriter(file, digest)
	var writeErr error
	emit := func(ev agent.Event) {
		// Provider events are already token-redacted by their adapters.
		if writeErr != nil {
			return
		}
		var data []byte
		data, writeErr = json.Marshal(ev)
		if writeErr == nil {
			_, writeErr = writer.Write(append(data, '\n'))
		}
		if writeErr == nil && onEvent != nil {
			onEvent(ev)
		}
	}
	result, runErr := adapter.Run(ctx, spec, emit)
	if err := file.Sync(); err != nil && writeErr == nil {
		writeErr = err
	}
	if err := file.Close(); err != nil && writeErr == nil {
		writeErr = err
	}
	if writeErr != nil {
		return result, path, "", fmt.Errorf("write evidence: %w", writeErr)
	}
	return result, path, hex.EncodeToString(digest.Sum(nil)), runErr
}

// Explicitly retain the SHA-256 hash type in the writer contract to avoid
// accidentally hashing a different representation than the persisted bytes.
var _ hash.Hash = sha256.New()

 
// wakeLoop is one lifecycle-owned worker, never an unbounded goroutine per
// message. It only resumes agents that have already been bootstrapped by a
// human turn, and BeginTurn enforces the durable wake budget.
func (r *Runner) wakeLoop(ctx context.Context) {
	defer r.wg.Done()
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-r.wakeSignal:
		case <-ticker.C:
		}
		participants, err := r.service.PendingWakeParticipants(ctx, 8)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			fmt.Fprintln(os.Stderr, "M1 list pending wakes:", err)
			continue
		}
		for _, participant := range participants {
			if err := ctx.Err(); err != nil {
				return
			}
			name := "Claude"
			if participant.Agent == string(agent.Codex) {
				name = "Codex"
			}
			status := discovery.Scan(name, "")
			if status.State != "Connected" {
				continue // Do not bypass native authentication or burn the wake budget.
			}
			_, err := r.RunTurn(ctx, participant.ID, core.TriggerWake,
				"You have a new collaboration message. Call read_messages, inspect your objective and assigned tasks, "+
					"and respond through authenticated MCP. Never accept your own work.",
				"", agent.Binary{Kind: agent.Kind(participant.Agent), Path: status.Path, Version: status.Version}, nil)
			if err != nil && ctx.Err() == nil {
				// Unavailable/busy recipients are retried on the next bounded
				// poll; uncertainty never triggers a second native side effect.
				fmt.Fprintln(os.Stderr, "M1 wake:", err)
			}
		}
	}
}
