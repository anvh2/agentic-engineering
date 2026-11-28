package issues

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/anvh2/agentic-engineering/app/internal/agent"
	"github.com/anvh2/agentic-engineering/app/internal/collaboration"
	"github.com/anvh2/agentic-engineering/app/internal/core"
	"github.com/anvh2/agentic-engineering/app/internal/team"
	"github.com/anvh2/agentic-engineering/app/internal/workspace"
	"github.com/go-logr/logr"
)

const (
	defaultMaxReviewRounds = 3
	maxRepositories        = 16
	maxActivity            = 1000
	maxCommands            = 500
)

// Turns runs native turns.
type Turns interface {
	RunTurn(context.Context, collaboration.TurnRequest) (collaboration.TurnReport, error)
}

// Store is the part of the collaboration store this service uses.
type Store interface {
	CreateProject(ctx context.Context, name, description string) (core.Project, error)
	CreateObjective(ctx context.Context, in core.ObjectiveInput) (core.ObjectiveRecord, error)
	PostHumanMessage(ctx context.Context, objectiveID, to, body, idempotencyKey string) (core.Message, error)
	ListMessages(ctx context.Context, objectiveID string, after int64, limit int) ([]core.Message, error)
	ListTasks(ctx context.Context, objectiveID string) ([]core.Task, error)
	ListReviews(ctx context.Context, objectiveID string) ([]core.Review, error)
	ListTurns(ctx context.Context, objectiveID string, limit int) ([]core.TurnSummary, error)
	SetTaskVerdict(ctx context.Context, objectiveID, taskID string, expectedRevision int64, accepted bool, summary string) (core.Task, error)
}

// Knowledge is the engineering knowledge selected for one agent.
type Knowledge struct {
	Version   string
	Status    string
	Revision  string
	Bootstrap string
	Index     string
	Directory string // on-demand documents; valid until Release
	Release   func()
}

// KnowledgeLoader loads an agent's knowledge for the given repositories.
type KnowledgeLoader func(ctx context.Context, profile team.Profile, repositoryDirs []string) (Knowledge, error)

// HarnessResolver returns the authenticated native executable of a harness.
type HarnessResolver func(ctx context.Context, harness string) (agent.Binary, error)

// Config wires a Service.
type Config struct {
	Turns       Turns
	Store       Store
	Agents      *team.Registry
	Knowledge   KnowledgeLoader
	Harness     HarnessResolver
	EvidenceDir string
	// Notify reports that an issue's view changed. It must not block.
	Notify          func(issueID string)
	Log             logr.Logger
	MaxReviewRounds int
}

// Service owns every issue execution. It is safe for concurrent use; each
// execution has its own worktrees, objective, sessions and worker.
type Service struct {
	turns       Turns
	store       Store
	agents      *team.Registry
	knowledge   KnowledgeLoader
	harness     HarnessResolver
	evidenceDir string
	notify      func(string)
	log         logr.Logger
	maxRounds   int

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	// worktreeMu serializes worktree creation: concurrent "git worktree add"
	// calls on one repository can fail on Git's own locks.
	worktreeMu sync.Mutex

	mu         sync.Mutex
	executions map[string]*execution
	closing    bool
}

type participant struct {
	profile   team.Profile
	duty      core.Duty
	id        string // collaboration participant id
	checkouts []workspace.Checkout
}

// execution is one issue's state. Service.mu guards every field except the
// participants' checkouts and ids, which the single worker writes during
// preparation before prepared is set.
type execution struct {
	view     Execution
	request  StartRequest
	assignee participant
	reviewer participant

	prepared  bool
	submitted bool         // the assignee handed off the captured snapshot
	verdict   core.Verdict // reviewer's verdict on that snapshot
	trees     []string     // captured tree per repository
	pending   map[core.Duty][]string
	queued    []string // Director comments written before the objective existed

	running bool
	run     int // identifies the current worker
	cancel  context.CancelFunc
}

// New returns a Service whose workers live within ctx.
func New(ctx context.Context, cfg Config) (*Service, error) {
	if cfg.Turns == nil || cfg.Store == nil || cfg.Agents == nil || cfg.Knowledge == nil || cfg.Harness == nil {
		return nil, errors.New("issue service requires turns, store, agents, knowledge and harness")
	}
	if !filepath.IsAbs(cfg.EvidenceDir) {
		return nil, errors.New("issue evidence directory must be absolute")
	}
	if cfg.MaxReviewRounds <= 0 {
		cfg.MaxReviewRounds = defaultMaxReviewRounds
	}
	if cfg.Notify == nil {
		cfg.Notify = func(string) {}
	}
	s := &Service{
		turns: cfg.Turns, store: cfg.Store, agents: cfg.Agents, knowledge: cfg.Knowledge,
		harness: cfg.Harness, evidenceDir: cfg.EvidenceDir, notify: cfg.Notify, log: cfg.Log,
		maxRounds: cfg.MaxReviewRounds, executions: map[string]*execution{},
	}
	s.ctx, s.cancel = context.WithCancel(ctx)
	return s, nil
}

// Close interrupts every execution and waits for its worker.
func (s *Service) Close(ctx context.Context) error {
	s.mu.Lock()
	s.closing = true
	s.cancel()
	s.mu.Unlock()
	done := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Start begins executing an issue, or resumes one that failed or was stopped.
// Exactly one execution of an issue can be active: concurrent calls get
// ErrAlreadyRunning.
func (s *Service) Start(ctx context.Context, req StartRequest) (Execution, error) {
	assignee, reviewer, err := s.assignment(req)
	if err != nil {
		return Execution{}, err
	}
	repositories, err := s.resolveRepositories(ctx, req.Repositories)
	if err != nil {
		return Execution{}, err
	}
	req.Repositories = repositories
	req.Comments = slices.Clone(req.Comments)

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return Execution{}, errors.New("application is shutting down")
	}
	previous := s.executions[req.IssueID]
	if previous != nil && previous.running {
		return Execution{}, ErrAlreadyRunning
	}
	if previous != nil && previous.view.Phase == PhaseInReview {
		return Execution{}, ErrAwaitingDirector
	}
	e := previous
	if e != nil && e.resumable(req, assignee, reviewer) {
		e.view.Attempt++
		e.view.ReviewRounds = 0
		e.view.Error = ""
		e.request.Title, e.request.IssueKey = req.Title, req.IssueKey
		s.recordLocked(e, "lifecycle", "Director", fmt.Sprintf("Retry requested (attempt %d)", e.view.Attempt))
	} else {
		attempt := 1
		if previous != nil {
			attempt = previous.view.Attempt + 1
		}
		e = s.newExecution(req, assignee, reviewer, attempt)
		s.executions[req.IssueID] = e
		s.recordLocked(e, "lifecycle", "Director", fmt.Sprintf("Execution started (attempt %d)", attempt))
	}
	s.launchLocked(e, PhasePreparing)
	return s.cloneLocked(e), nil
}

// Stop interrupts an active execution, or withdraws a result that waits for
// the Director. Stopping a stopped execution has no effect.
func (s *Service) Stop(issueID string) (Execution, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.executions[issueID]
	if e == nil {
		return Execution{}, ErrNotFound
	}
	if e.view.Phase == PhaseAccepting || e.view.Phase == PhaseAccepted {
		return Execution{}, fmt.Errorf("%w: the Director's acceptance cannot be stopped", ErrInvalidRequest)
	}
	if e.running {
		if e.view.Phase != PhaseStopping {
			e.view.Phase, e.view.Detail = PhaseStopping, "Interrupting the native turn"
			s.recordLocked(e, "lifecycle", "Director", "Stop requested")
			e.cancel()
			s.changedLocked(e)
		}
		return s.cloneLocked(e), nil
	}
	if e.view.Phase == PhaseInReview || e.view.Phase == PhaseFailed {
		// A stopped result needs a fresh independent verdict.
		e.view.Phase, e.view.Detail, e.view.ApprovedReview = PhaseStopped, "Stopped by the Director", ""
		e.verdict = ""
		s.recordLocked(e, "lifecycle", "Director", "Stopped")
		s.changedLocked(e)
	}
	return s.cloneLocked(e), nil
}

// Comment delivers a Director comment. Mentioned agents receive it in their
// next turn; on a result in review, a mention starts that turn immediately.
func (s *Service) Comment(ctx context.Context, issueID, body string) (CommentResult, error) {
	logger := s.log.WithName("Service.Comment").WithValues("issue_id", issueID)
	body = strings.TrimSpace(body)
	if body == "" || len(body) > core.MaxMessageBytes {
		return CommentResult{}, fmt.Errorf("%w: a comment needs 1 to %d bytes", ErrInvalidRequest, core.MaxMessageBytes)
	}
	s.mu.Lock()
	e := s.executions[issueID]
	if e == nil {
		s.mu.Unlock()
		return CommentResult{}, ErrNotFound
	}
	targets := e.mentioned(body)
	result := CommentResult{Delivery: "recorded", Recipients: []string{}}
	for _, p := range targets {
		result.Recipients = append(result.Recipients, p.profile.Handle)
	}
	if e.view.ObjectiveID == "" {
		e.queued = append(e.queued, body)
		result.Delivery = "on_retry"
		if e.running {
			result.Delivery = "queued"
		}
		s.recordLocked(e, "comment", "Director", body)
		s.changedLocked(e)
		s.mu.Unlock()
		return result, nil
	}
	objectiveID := e.view.ObjectiveID
	s.mu.Unlock()

	to := ""
	if len(targets) == 1 {
		to = targets[0].profile.Handle
	}
	if _, err := s.store.PostHumanMessage(ctx, objectiveID, to, body, ""); err != nil {
		logger.Error(err, "Store.PostHumanMessage")
		return CommentResult{}, fmt.Errorf("record comment: %w", err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.recordLocked(e, "comment", "Director", body)
	defer s.changedLocked(e)
	if s.executions[issueID] != e || e.view.Phase == PhaseAccepting || e.view.Phase == PhaseAccepted || len(targets) == 0 {
		return result, nil
	}
	for _, p := range targets {
		e.pending[p.duty] = append(e.pending[p.duty], body)
	}
	e.view.PendingComments = e.pendingCount()
	if e.running {
		result.Delivery = "queued"
		return result, nil
	}
	if e.view.Phase == PhaseInReview && !s.closing {
		result.Delivery = "started"
		e.view.ReviewRounds = 0
		s.launchLocked(e, PhaseResponding)
		return result, nil
	}
	result.Delivery = "on_retry"
	return result, nil
}

// Accept records the Director's acceptance of an independently approved
// result. It is refused while work is running, without a current approval, or
// when the implementation differs from what was approved.
func (s *Service) Accept(ctx context.Context, issueID, note string) (Execution, error) {
	note = strings.TrimSpace(note)
	if len(note) > core.MaxSummaryBytes/2 {
		return Execution{}, fmt.Errorf("%w: acceptance note is too long", ErrInvalidRequest)
	}
	s.mu.Lock()
	e := s.executions[issueID]
	if e == nil {
		s.mu.Unlock()
		return Execution{}, ErrNotFound
	}
	if e.running || e.view.Phase != PhaseInReview || e.verdict != core.VerdictApproved || e.pendingCount() > 0 || s.closing {
		s.mu.Unlock()
		return Execution{}, ErrNotInReview
	}
	e.running, e.view.Phase, e.view.Detail = true, PhaseAccepting, "Verifying the approved change"
	s.changedLocked(e)
	s.mu.Unlock()

	err := s.accept(ctx, e, note)

	s.mu.Lock()
	defer s.mu.Unlock()
	defer s.changedLocked(e)
	e.running = false
	if errors.Is(err, ErrStale) {
		e.view.Phase, e.view.Error, e.view.ApprovedReview = PhaseFailed, err.Error(), ""
		e.submitted, e.verdict = false, ""
		s.recordLocked(e, "lifecycle", "Runtime", "Acceptance refused: "+err.Error())
		return s.cloneLocked(e), err
	}
	if err != nil {
		e.view.Phase, e.view.Detail = PhaseInReview, "Waiting for the Director"
		return s.cloneLocked(e), err
	}
	e.view.Phase, e.view.Detail = PhaseAccepted, "Accepted by the Director"
	e.view.AcceptedAt, e.view.AcceptNote = now(), note
	s.recordLocked(e, "lifecycle", "Director", "Accepted the reviewed change")
	return s.cloneLocked(e), nil
}

func (s *Service) accept(ctx context.Context, e *execution, note string) error {
	logger := s.log.WithName("Service.accept").WithValues("issue_id", e.request.IssueID)
	s.mu.Lock()
	objectiveID, approved := e.view.ObjectiveID, e.view.ApprovedReview
	trees := slices.Clone(e.trees)
	commits := make([]string, 0, len(e.view.Repositories))
	for _, r := range e.view.Repositories {
		commits = append(commits, r.Name+"@"+r.SnapshotCommit)
	}
	s.mu.Unlock()

	reviews, err := s.store.ListReviews(ctx, objectiveID)
	if err != nil {
		logger.Error(err, "Store.ListReviews")
		return err
	}
	if len(reviews) == 0 || reviews[len(reviews)-1].ID != approved || reviews[len(reviews)-1].Verdict != core.VerdictApproved {
		return ErrNotInReview
	}
	if err := s.verifyUnchanged(ctx, e, trees); err != nil {
		return err
	}
	tasks, err := s.store.ListTasks(ctx, objectiveID)
	if err != nil {
		logger.Error(err, "Store.ListTasks")
		return err
	}
	if len(tasks) != 1 {
		return fmt.Errorf("%w: implementation task is missing", ErrNotInReview)
	}
	summary := fmt.Sprintf("Director accepted. Approved review %s of %s.", approved, strings.Join(commits, ", "))
	if note != "" {
		summary += " Note: " + note
	}
	if len(summary) > core.MaxSummaryBytes {
		summary = strings.ToValidUTF8(summary[:core.MaxSummaryBytes], "")
	}
	if _, err := s.store.SetTaskVerdict(ctx, objectiveID, tasks[0].ID, tasks[0].Revision, true, summary); err != nil {
		logger.Error(err, "Store.SetTaskVerdict")
		return err
	}
	return nil
}

// Get returns the issue's full view. An issue never executed in this app
// session has an empty view with no phase.
func (s *Service) Get(ctx context.Context, issueID string) (Execution, error) {
	s.mu.Lock()
	e := s.executions[issueID]
	if e == nil {
		s.mu.Unlock()
		return Execution{}, nil
	}
	view := s.cloneLocked(e)
	s.mu.Unlock()
	if view.ObjectiveID == "" {
		return view, nil
	}
	return s.hydrate(ctx, view)
}

// List returns every execution with runs and usage but without patches,
// commands, activity or messages.
func (s *Service) List(ctx context.Context) ([]Execution, error) {
	s.mu.Lock()
	views := make([]Execution, 0, len(s.executions))
	for _, e := range s.executions {
		view := s.cloneLocked(e)
		view.Activity, view.Commands = []Activity{}, []Command{}
		for i := range view.Repositories {
			view.Repositories[i].Patch = ""
		}
		views = append(views, view)
	}
	s.mu.Unlock()
	sort.Slice(views, func(i, j int) bool { return views[i].IssueKey < views[j].IssueKey })
	for i := range views {
		if views[i].ObjectiveID == "" {
			continue
		}
		full, err := s.hydrate(ctx, views[i])
		if err != nil {
			return nil, err
		}
		full.Messages = []Message{}
		views[i] = full
	}
	return views, nil
}

// ObjectiveChanged notifies the view of the issue that owns an objective.
func (s *Service) ObjectiveChanged(objectiveID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.executions {
		if e.view.ObjectiveID == objectiveID {
			s.changedLocked(e)
		}
	}
}

// hydrate adds the durable collaboration records to a view.
func (s *Service) hydrate(ctx context.Context, view Execution) (Execution, error) {
	logger := s.log.WithName("Service.hydrate").WithValues("issue_id", view.IssueID)
	messages, err := s.store.ListMessages(ctx, view.ObjectiveID, 0, 0)
	if err != nil {
		logger.Error(err, "Store.ListMessages")
		return view, err
	}
	for _, m := range messages {
		view.Messages = append(view.Messages, Message{Seq: m.Seq, From: m.From, To: m.To, Body: m.Body,
			At: m.CreatedAt.Format(time.RFC3339Nano)})
	}
	if view.Reviews, err = s.store.ListReviews(ctx, view.ObjectiveID); err != nil {
		logger.Error(err, "Store.ListReviews")
		return view, err
	}
	if view.Tasks, err = s.store.ListTasks(ctx, view.ObjectiveID); err != nil {
		logger.Error(err, "Store.ListTasks")
		return view, err
	}
	turns, err := s.store.ListTurns(ctx, view.ObjectiveID, core.MaxReadLimit)
	if err != nil {
		logger.Error(err, "Store.ListTurns")
		return view, err
	}
	usage := make(map[string][]Usage, len(turns))
	for _, turn := range turns {
		for _, u := range turn.Usage {
			if idle(u) {
				continue
			}
			usage[turn.TurnID] = append(usage[turn.TurnID], usageView(u))
		}
	}
	for i := range view.Runs {
		if records := usage[view.Runs[i].TurnID]; records != nil {
			view.Runs[i].Usage = records
		}
	}
	return view, nil
}

// idle reports a model that did no work in a turn; the row only keeps the
// session baseline.
func idle(u core.TurnUsageSummary) bool {
	zero := func(n *int64) bool { return n == nil || *n == 0 }
	return u.Output != nil && *u.Output == 0 && zero(u.UncachedInput) && zero(u.CacheRead) &&
		zero(u.CacheWrite) && (u.CostUSD == nil || *u.CostUSD == 0)
}

func usageView(u core.TurnUsageSummary) Usage {
	out := Usage{Model: u.Model, CacheRead: u.CacheRead, CacheWrite: u.CacheWrite, Output: u.Output, CostUSD: u.CostUSD}
	if u.UncachedInput == nil {
		return out
	}
	total := *u.UncachedInput
	if u.CacheRead != nil {
		total += *u.CacheRead
	}
	if u.CacheWrite != nil {
		total += *u.CacheWrite
	}
	out.InputTokens = &total
	return out
}

func (s *Service) assignment(req StartRequest) (team.Profile, team.Profile, error) {
	var none team.Profile
	invalid := func(format string, a ...any) error {
		return fmt.Errorf("%w: %s", ErrInvalidRequest, fmt.Sprintf(format, a...))
	}
	if req.IssueID == "" || strings.TrimSpace(req.Title) == "" {
		return none, none, invalid("issue ID and title are required")
	}
	if len(req.Title)+len(req.Description)+len(req.AcceptanceCriteria) > core.MaxMessageBytes*4 {
		return none, none, invalid("issue text is too long")
	}
	if len(req.Comments) > 50 {
		return none, none, invalid("too many comments to deliver at once")
	}
	if req.AssigneeID == "" || req.ReviewerID == "" {
		return none, none, invalid("select an assignee and a reviewer from Team")
	}
	if req.AssigneeID == req.ReviewerID {
		return none, none, invalid("the reviewer must be a different agent from the assignee")
	}
	assignee, ok := s.agents.Get(req.AssigneeID)
	if !ok {
		return none, none, invalid("assignee is not a configured Team agent")
	}
	reviewer, ok := s.agents.Get(req.ReviewerID)
	if !ok {
		return none, none, invalid("reviewer is not a configured Team agent")
	}
	for _, p := range []team.Profile{assignee, reviewer} {
		if p.KnowledgeRoot == "" {
			return none, none, invalid("connect engineering-knowledge before running %s", p.Name)
		}
	}
	return assignee, reviewer, nil
}

func (s *Service) resolveRepositories(ctx context.Context, repositories []workspace.Repository) ([]workspace.Repository, error) {
	if len(repositories) == 0 || len(repositories) > maxRepositories {
		return nil, fmt.Errorf("%w: link 1 to %d repositories to the project", ErrInvalidRequest, maxRepositories)
	}
	out := make([]workspace.Repository, 0, len(repositories))
	seen := map[string]bool{}
	for _, repository := range repositories {
		path, err := workspace.Resolve(ctx, repository.Path)
		if err != nil {
			return nil, fmt.Errorf("%w: repository %s: %w", ErrInvalidRequest, repository.Name, err)
		}
		if seen[path] {
			continue // Two links to one checkout share a workspace.
		}
		seen[path] = true
		repository.Path = path
		if strings.TrimSpace(repository.Name) == "" {
			repository.Name = filepath.Base(path)
		}
		out = append(out, repository)
	}
	return out, nil
}

func (s *Service) newExecution(req StartRequest, assignee, reviewer team.Profile, attempt int) *execution {
	e := &execution{
		request:  req,
		assignee: participant{profile: assignee, duty: core.DutyAssignee},
		reviewer: participant{profile: reviewer, duty: core.DutyReviewer},
		pending:  map[core.Duty][]string{},
		queued:   slices.Clone(req.Comments),
		view: Execution{
			IssueID: req.IssueID, IssueKey: req.IssueKey, ProjectID: req.ProjectID, Title: req.Title,
			Attempt: attempt, MaxReviewRounds: s.maxRounds,
			Assignee: ref(assignee, core.DutyAssignee), Reviewer: ref(reviewer, core.DutyReviewer),
			Repositories: []RepositoryState{}, Runs: []Run{}, Commands: []Command{}, Activity: []Activity{},
			Messages: []Message{}, Reviews: []core.Review{}, Tasks: []core.Task{},
		},
	}
	for _, r := range req.Repositories {
		e.view.Repositories = append(e.view.Repositories, RepositoryState{ID: r.ID, Name: r.Name, Path: r.Path})
	}
	return e
}

// resumable reports whether a retry may continue in the same worktrees and
// native sessions: the assignment and repositories must be unchanged.
func (e *execution) resumable(req StartRequest, assignee, reviewer team.Profile) bool {
	if !e.prepared || (e.view.Phase != PhaseFailed && e.view.Phase != PhaseStopped) {
		return false
	}
	same := func(a, b team.Profile) bool {
		return a.ID == b.ID && a.Handle == b.Handle && a.Harness == b.Harness && a.Model == b.Model &&
			a.Role == b.Role && a.KnowledgeRoot == b.KnowledgeRoot &&
			slices.Equal(a.Languages, b.Languages) && slices.Equal(a.Assigned, b.Assigned)
	}
	return same(e.assignee.profile, assignee) && same(e.reviewer.profile, reviewer) &&
		slices.Equal(e.request.Repositories, req.Repositories) &&
		e.request.Description == req.Description && e.request.AcceptanceCriteria == req.AcceptanceCriteria
}

var mentionPattern = regexp.MustCompile(`(?:^|[^\w@])@([a-z][a-z0-9_-]*)`)

func (e *execution) mentioned(body string) []participant {
	handles := map[string]bool{}
	for _, match := range mentionPattern.FindAllStringSubmatch(strings.ToLower(body), -1) {
		handles[match[1]] = true
	}
	var out []participant
	for _, p := range []participant{e.assignee, e.reviewer} {
		if handles[p.profile.Handle] {
			out = append(out, p)
		}
	}
	return out
}

func (e *execution) pendingCount() int {
	return len(e.pending[core.DutyAssignee]) + len(e.pending[core.DutyReviewer])
}

// launchLocked starts the execution's worker. s.mu must be held.
func (s *Service) launchLocked(e *execution, phase Phase) {
	ctx, cancel := context.WithCancel(s.ctx)
	e.running, e.cancel = true, cancel
	e.run++
	e.view.Phase, e.view.Detail, e.view.Error = phase, "Starting", ""
	s.changedLocked(e)
	s.wg.Add(1)
	go s.work(ctx, cancel, e, e.run)
}

func (s *Service) work(ctx context.Context, cancel context.CancelFunc, e *execution, run int) {
	defer s.wg.Done()
	defer cancel()
	err := s.execute(ctx, e)
	s.mu.Lock()
	defer s.mu.Unlock()
	if e.run != run || !e.running || e.view.Phase == PhaseAccepting {
		return // execute already handed the execution over.
	}
	e.running = false
	if ctx.Err() != nil {
		e.view.Phase, e.view.Detail = PhaseStopped, "Stopped before completion"
		s.recordLocked(e, "lifecycle", "Runtime", "Execution stopped")
	} else if err != nil {
		e.view.Phase, e.view.Detail, e.view.Error = PhaseFailed, "Execution failed", err.Error()
		s.recordLocked(e, "lifecycle", "Runtime", "Execution failed: "+err.Error())
	}
	s.changedLocked(e)
}

// recordLocked appends an activity entry. s.mu must be held.
func (s *Service) recordLocked(e *execution, kind, actor, text string) {
	seq := 1
	if n := len(e.view.Activity); n > 0 {
		seq = e.view.Activity[n-1].Seq + 1
	}
	e.view.Activity = append(e.view.Activity, Activity{Seq: seq, At: now(), Kind: kind, Actor: actor, Text: text})
	if over := len(e.view.Activity) - maxActivity; over > 0 {
		e.view.Activity = slices.Delete(e.view.Activity, 0, over)
	}
}

// changedLocked stamps the view and notifies listeners. s.mu must be held; the
// notifier never blocks.
func (s *Service) changedLocked(e *execution) {
	e.view.UpdatedAt = now()
	s.notify(e.view.IssueID)
}

// cloneLocked returns a copy that shares no memory with the execution.
func (s *Service) cloneLocked(e *execution) Execution {
	view := e.view
	view.Active = e.running
	view.PendingComments = e.pendingCount()
	encoded, err := json.Marshal(view)
	if err != nil {
		panic(fmt.Sprintf("encode execution view: %v", err)) // Only plain data types.
	}
	var out Execution
	if err := json.Unmarshal(encoded, &out); err != nil {
		panic(fmt.Sprintf("decode execution view: %v", err))
	}
	return out
}

func ref(p team.Profile, duty core.Duty) AgentRef {
	return AgentRef{ID: p.ID, Name: p.Name, Handle: p.Handle, Role: p.Role, Harness: p.Harness, Model: p.Model, Duty: duty}
}

func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }
