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
	turnDeadline   = 4 * time.Hour
	finishDeadline = 10 * time.Second
)

type Runner struct {
	service     *core.Service
	db          *sql.DB
	endpoint    *mcp.Endpoint
	evidenceDir string
	agents      map[agent.Kind]agent.Adapter
	wakeSignal  chan struct{}
	wakeCancel  context.CancelFunc

	mu      sync.Mutex
	active  map[string]context.CancelFunc
	closing bool
	observe func(objectiveID string)
	wg      sync.WaitGroup
}

// TurnReport is the outcome of one native turn. Usage is read from core, which
// converts the harness's session totals into per-turn values.
type TurnReport struct {
	TurnID          string `json:"turnId"`
	SessionID       string `json:"sessionId"`
	Participant     string `json:"participant"`
	Provider        string `json:"provider"`
	State           string `json:"state"`
	FinalText       string `json:"finalText"`
	NativeSessionID string `json:"nativeSessionId"`
	ToolFailures    int    `json:"toolFailures"`
	EvidencePath    string `json:"evidencePath"`
	EvidenceSHA256  string `json:"evidenceSha256"`
	Error           string `json:"error,omitempty"`
}

// TurnRequest describes one turn the trusted desktop runtime wants to run.
type TurnRequest struct {
	ParticipantID string
	Trigger       core.Trigger
	Prompt        string
	// Instructions is applied only when the turn creates a native session.
	Instructions string
	Binary       agent.Binary
	Access       agent.Access
	AddDirs      []string
	// OnStart runs once the turn is durable, before the native process starts.
	OnStart func(turnID, sessionID string)
	// OnEvent receives native events in order, synchronously.
	OnEvent func(agent.Event)
}

// Option configures Open.
type Option func(*Runner)

// WithAdapter replaces the adapter of one harness kind.
func WithAdapter(adapter agent.Adapter) Option {
	return func(r *Runner) { r.agents[adapter.Kind()] = adapter }
}

func Open(ctx context.Context, dbPath, evidenceDir string, options ...Option) (*Runner, error) {
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
		active:     make(map[string]context.CancelFunc),
		wakeSignal: make(chan struct{}, 1),
		agents: map[agent.Kind]agent.Adapter{
			agent.Claude: agent.ClaudeAdapter{},
			agent.Codex:  agent.CodexAdapter{},
		},
	}
	for _, option := range options {
		option(r)
	}
	wakeCtx, cancel := context.WithCancel(ctx)
	r.wakeCancel = cancel
	service.SetMessageNotifier(func(objectiveID string) {
		r.mu.Lock()
		observe := r.observe
		r.mu.Unlock()
		if observe != nil {
			observe(objectiveID)
		}
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

// OnMessage installs a nonblocking observer of new collaboration messages.
func (r *Runner) OnMessage(observe func(objectiveID string)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.observe = observe
}

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
	// The managed worker and all native turns must exit before SQLite closes.
	// The desktop caller supplies a bounded lifecycle context, but returning
	// before owned processes stop would leave a background writer on a closed DB.
	r.wg.Wait()
	if err := ctx.Err(); err != nil {
		// Close transport with a fresh bounded cleanup context when the
		// initiating shutdown context has already expired.
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), finishDeadline)
		defer cancel()
		_ = r.endpoint.Close(cleanupCtx)
		_ = r.db.Close()
		return err
	}
	err := r.endpoint.Close(ctx)
	if closeErr := r.db.Close(); err == nil {
		err = closeErr
	}
	return err
}

func (r *Runner) RunTurn(ctx context.Context, req TurnRequest) (TurnReport, error) {
	participantID, binary := req.ParticipantID, req.Binary
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

	lease, err := r.service.BeginTurn(ctx, participantID, req.Trigger, req.Prompt, req.Instructions, binary)
	if err != nil {
		return TurnReport{}, err
	}
	report := TurnReport{TurnID: lease.TurnID, SessionID: lease.SessionID,
		Participant: lease.Handle, Provider: p.Agent, State: "failed"}
	if req.OnStart != nil {
		req.OnStart(lease.TurnID, lease.SessionID)
	}
	spec := agent.TurnSpec{Binary: binary, Workdir: lease.Workdir,
		Prompt: req.Prompt, Instructions: lease.Instructions, Model: nativeModel(p.Model),
		MCPURL: r.endpoint.URL, Token: lease.Token, Access: req.Access, AddDirs: req.AddDirs}
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
		result    agent.TurnResult
		logPath   string
		logDigest string
	)
	if err == nil {
		result, logPath, logDigest, err = r.execute(ctx, adapter, spec, lease.TurnID, req.OnEvent)
	}
	if ctx.Err() != nil {
		result.Interrupted = true
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
	report.EvidencePath = logPath
	report.EvidenceSHA256 = logDigest
	if result.Interrupted || ctx.Err() != nil {
		report.State = "interrupted"
		report.Error = "turn interrupted"
	} else if err != nil {
		report.Error = "native turn failed: " + err.Error()
	} else if result.ExitCode == 0 && result.NativeError == "" {
		report.State = "succeeded"
	} else {
		report.Error = result.NativeError
		if report.Error == "" {
			report.Error = fmt.Sprintf("native process exited with code %d", result.ExitCode)
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
	lastNativeID := ""
	emit := func(ev agent.Event) {
		// Provider events are already token-redacted by their adapters.
		if writeErr != nil {
			return
		}
		if ev.NativeID != "" && ev.NativeID != lastNativeID {
			// Persist native session identity before subsequent provider work.
			// In particular Codex may emit thread.started then crash, and the
			// next process must never create a duplicate session by guessing.
			if err := r.service.RecordNativeSessionID(ctx, turnID, ev.NativeID); err != nil {
				writeErr = fmt.Errorf("record native session identity: %w", err)
				return
			}
			lastNativeID = ev.NativeID
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
		pending, err := r.service.PendingWakeParticipants(ctx, 8)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			fmt.Fprintln(os.Stderr, "M1 pending wakes:", err)
			continue
		}
		for _, p := range pending {
			if ctx.Err() != nil {
				return
			}
			name := "Claude"
			if p.Agent == string(agent.Codex) {
				name = "Codex"
			}
			status := discovery.Scan(name, "")
			if status.State != "Connected" {
				continue
			}
			_, err := r.RunTurn(ctx, TurnRequest{ParticipantID: p.ID, Trigger: core.TriggerWake,
				Prompt: "You have a collaboration message. Read messages and your objective through authenticated MCP, then act only within native permissions.",
				Binary: agent.Binary{Kind: agent.Kind(p.Agent), Path: status.Path, Version: status.Version}})
			if err != nil && ctx.Err() == nil {
				fmt.Fprintln(os.Stderr, "M1 wake:", err)
			}
		}
	}
}

// nativeModel maps the Team UI's "Default" to the harness default model.
func nativeModel(model string) string {
	if model == "Default" {
		return ""
	}
	return model
}
