package main

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/anvh2/agentic-engineering/app/internal/agent"
	"github.com/anvh2/agentic-engineering/app/internal/collaboration"
	"github.com/anvh2/agentic-engineering/app/internal/discovery"
	"github.com/anvh2/agentic-engineering/app/internal/issues"
	"github.com/anvh2/agentic-engineering/app/internal/team"
	"github.com/go-logr/logr"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	issueEvent         = "issue-execution"
	issueEventInterval = 200 * time.Millisecond
	shutdownDeadline   = 30 * time.Second
	// pinnedKnowledgeVersion is the engineering-knowledge release execution
	// was verified against.
	pinnedKnowledgeVersion = "1.0.0"
	// dataDirEnv overrides where collaboration state is kept, for isolated
	// test runs.
	dataDirEnv = "AE_DATA_DIR"
)

// IssueRuntime is the trusted desktop boundary of issue execution. It is
// deliberately separate from MCP: only the human-operated UI starts, stops,
// comments on and accepts work.
type IssueRuntime struct {
	log    logr.Logger
	agents *team.Registry
	emit   func(ctx context.Context, issueID string)

	mu           sync.RWMutex
	ctx          context.Context
	runner       *collaboration.Runner
	service      *issues.Service
	startErr     error
	harnessPaths map[string]string
	stopEmit     context.CancelFunc
	emitDone     chan struct{}

	changedMu sync.Mutex
	changed   map[string]bool
	signal    chan struct{}
}

// TeamSync is the Team configured in the UI.
type TeamSync struct {
	Agents []team.Profile `json:"agents"`
	// HarnessPaths optionally overrides executable discovery per harness.
	HarnessPaths map[string]string `json:"harnessPaths"`
}

func newIssueRuntime(log logr.Logger) *IssueRuntime {
	return &IssueRuntime{
		log: log, agents: team.NewRegistry(), changed: map[string]bool{}, signal: make(chan struct{}, 1),
		emit: func(ctx context.Context, issueID string) { wailsruntime.EventsEmit(ctx, issueEvent, issueID) },
	}
}

func (r *IssueRuntime) start(ctx context.Context) {
	logger := r.log.WithName("IssueRuntime.start")
	r.mu.Lock()
	defer r.mu.Unlock()
	r.ctx = ctx
	directory, err := dataDirectory()
	if err != nil {
		logger.Error(err, "dataDirectory")
		r.startErr = err
		return
	}
	evidence := filepath.Join(directory, "evidence")
	runner, err := collaboration.Open(ctx, filepath.Join(directory, "collaboration.sqlite"), evidence)
	if err != nil {
		logger.Error(err, "collaboration.Open")
		r.startErr = err
		return
	}
	service, err := issues.New(ctx, issues.Config{
		Turns: runner, Store: runner.Service(), Agents: r.agents, Knowledge: loadAgentKnowledge,
		Harness: r.resolveHarness, EvidenceDir: evidence, Notify: r.markChanged, Log: r.log,
	})
	if err != nil {
		logger.Error(err, "issues.New")
		r.startErr = errors.Join(err, runner.Close(ctx))
		return
	}
	runner.OnMessage(service.ObjectiveChanged)
	r.runner, r.service = runner, service
	emitCtx, cancel := context.WithCancel(ctx)
	r.stopEmit, r.emitDone = cancel, make(chan struct{})
	go r.emitChanges(emitCtx, ctx, r.emitDone)
}

func dataDirectory() (string, error) {
	if override := os.Getenv(dataDirEnv); override != "" {
		if !filepath.IsAbs(override) {
			return "", fmt.Errorf("%s must be an absolute path", dataDirEnv)
		}
		return override, os.MkdirAll(override, 0700)
	}
	config, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	directory := filepath.Join(config, "agentic-engineering", "v2")
	return directory, os.MkdirAll(directory, 0700)
}

// stop interrupts owned turns, persists their terminal state and revokes their
// credentials, even when Wails' own shutdown context is already cancelled.
func (r *IssueRuntime) stop(ctx context.Context) {
	logger := r.log.WithName("IssueRuntime.stop")
	r.mu.Lock()
	runner, service, stopEmit, emitDone := r.runner, r.service, r.stopEmit, r.emitDone
	r.runner, r.service, r.stopEmit = nil, nil, nil
	r.mu.Unlock()
	if runner == nil {
		return
	}
	shutdown, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownDeadline)
	defer cancel()
	if err := service.Close(shutdown); err != nil {
		logger.Error(err, "issues.Close")
	}
	stopEmit()
	<-emitDone
	if err := runner.Close(shutdown); err != nil {
		logger.Error(err, "collaboration.Close")
	}
}

// markChanged queues a UI notification without blocking its caller.
func (r *IssueRuntime) markChanged(issueID string) {
	r.changedMu.Lock()
	r.changed[issueID] = true
	r.changedMu.Unlock()
	select {
	case r.signal <- struct{}{}:
	default:
	}
}

// emitChanges coalesces notifications so a busy native stream cannot flood the
// webview.
func (r *IssueRuntime) emitChanges(ctx, app context.Context, done chan<- struct{}) {
	defer close(done)
	for {
		select {
		case <-ctx.Done():
			return
		case <-r.signal:
		}
		r.changedMu.Lock()
		ids := slices.Sorted(maps.Keys(r.changed))
		clear(r.changed)
		r.changedMu.Unlock()
		for _, id := range ids {
			r.emit(app, id)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(issueEventInterval):
		}
	}
}

func (r *IssueRuntime) ready() (*issues.Service, context.Context, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.service != nil {
		return r.service, r.ctx, nil
	}
	if r.startErr != nil {
		return nil, nil, fmt.Errorf("issue runtime is unavailable: %w", r.startErr)
	}
	return nil, nil, errors.New("issue runtime is not running")
}

// SyncTeam replaces the Team agent registry and reports unusable profiles.
func (r *IssueRuntime) SyncTeam(req TeamSync) []team.Rejection {
	r.mu.Lock()
	r.harnessPaths = maps.Clone(req.HarnessPaths)
	r.mu.Unlock()
	return r.agents.Replace(req.Agents)
}

// StartIssue executes an issue, or resumes a failed or stopped execution.
func (r *IssueRuntime) StartIssue(req issues.StartRequest) (issues.Execution, error) {
	service, ctx, err := r.ready()
	if err != nil {
		return issues.Execution{}, err
	}
	return service.Start(ctx, req)
}

// StopIssue interrupts the issue's execution.
func (r *IssueRuntime) StopIssue(issueID string) (issues.Execution, error) {
	service, _, err := r.ready()
	if err != nil {
		return issues.Execution{}, err
	}
	return service.Stop(issueID)
}

// CommentOnIssue records a Director comment and delivers it to mentioned agents.
func (r *IssueRuntime) CommentOnIssue(issueID, body string) (issues.CommentResult, error) {
	service, ctx, err := r.ready()
	if err != nil {
		return issues.CommentResult{}, err
	}
	return service.Comment(ctx, issueID, body)
}

// AcceptIssue records the Director's acceptance of a reviewed result.
func (r *IssueRuntime) AcceptIssue(issueID, note string) (issues.Execution, error) {
	service, ctx, err := r.ready()
	if err != nil {
		return issues.Execution{}, err
	}
	return service.Accept(ctx, issueID, note)
}

// GetIssueExecution returns an issue's execution; its phase is empty when the
// issue was not executed since the app started.
func (r *IssueRuntime) GetIssueExecution(issueID string) (issues.Execution, error) {
	service, ctx, err := r.ready()
	if err != nil {
		return issues.Execution{}, err
	}
	return service.Get(ctx, issueID)
}

// ListIssueExecutions summarizes every execution with its runs and usage.
func (r *IssueRuntime) ListIssueExecutions() ([]issues.Execution, error) {
	service, ctx, err := r.ready()
	if err != nil {
		return nil, err
	}
	return service.List(ctx)
}

// resolveHarness finds the harness executable and verifies its native login.
func (r *IssueRuntime) resolveHarness(ctx context.Context, harness string) (agent.Binary, error) {
	if err := ctx.Err(); err != nil {
		return agent.Binary{}, err
	}
	r.mu.RLock()
	override := r.harnessPaths[harness]
	r.mu.RUnlock()
	status := discovery.Scan(harness, override)
	if status.State != "Connected" {
		return agent.Binary{}, fmt.Errorf("%s native login not verified: %s", harness, status.Diagnostic)
	}
	path, err := filepath.EvalSymlinks(status.Path)
	if err != nil {
		return agent.Binary{}, fmt.Errorf("resolve %s executable: %w", harness, err)
	}
	kind := agent.Claude
	if harness == team.HarnessCodex {
		kind = agent.Codex
	}
	return agent.Binary{Kind: kind, Path: path, Version: status.Version}, nil
}

// loadAgentKnowledge selects the agent's engineering knowledge for the
// languages of every repository it will work in.
func loadAgentKnowledge(ctx context.Context, profile team.Profile, repositoryDirs []string) (issues.Knowledge, error) {
	languages := profile.Languages
	for _, dir := range repositoryDirs {
		languages = repositoryLanguages(dir, languages)
	}
	selected, err := BuildKnowledgeContext(ctx, KnowledgeContextRequest{
		AgentID: profile.ID, Root: profile.KnowledgeRoot, Role: profile.Role,
		Languages: languages, Assigned: profile.Assigned,
	})
	if err != nil {
		return issues.Knowledge{}, fmt.Errorf("load engineering knowledge: %w", err)
	}
	release := func() {
		if selected.Directory != "" {
			_ = os.RemoveAll(selected.Directory) // Best effort cleanup of a temporary copy.
		}
	}
	if selected.Version != pinnedKnowledgeVersion {
		release()
		return issues.Knowledge{}, fmt.Errorf("execution is pinned to engineering-knowledge %s, found %s", pinnedKnowledgeVersion, selected.Version)
	}
	return issues.Knowledge{
		Version: selected.Version, Status: selected.Status, Revision: selected.Revision,
		Bootstrap: selected.Bootstrap, Index: selected.Index, Directory: selected.Directory, Release: release,
	}, nil
}
