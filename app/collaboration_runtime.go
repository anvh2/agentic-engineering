package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/anvh2/agentic-engineering/app/internal/agent"
	"github.com/anvh2/agentic-engineering/app/internal/collaboration"
	"github.com/anvh2/agentic-engineering/app/internal/core"
	"github.com/anvh2/agentic-engineering/app/internal/discovery"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// M1Runtime is a trusted desktop boundary. It is deliberately separate from
// MCP: only the human-operated Wails UI can create and judge objectives.
type M1Runtime struct {
	mu sync.Mutex
	ctx context.Context
	runner *collaboration.Runner
	startErr error
}

type M1CreateRequest struct {
	Repository string `json:"repository"`
	Title string `json:"title"`
	Description string `json:"description"`
	AcceptanceCriteria string `json:"acceptanceCriteria"`
	Developer string `json:"developer"` // Claude or Codex
	Reviewer string `json:"reviewer"`   // the other provider
	WakeBudget int `json:"wakeBudget"`
	Tasks []string `json:"tasks"`
}

type M1Objective struct {
	ID string `json:"id"`
	ProjectID string `json:"projectId"`
	Participants []core.ParticipantRecord `json:"participants"`
	Tasks []core.Task `json:"tasks"`
}

type M1Snapshot struct {
	Objective core.ObjectiveView `json:"objective"`
	Participants []core.ParticipantRecord `json:"participants"`
	Messages []core.Message `json:"messages"`
	Turns []core.TurnSummary `json:"turns"`
}

type M1RunRequest struct {
	ParticipantID string `json:"participantId"`
	Prompt string `json:"prompt"`
	KnowledgeRoot string `json:"knowledgeRoot"`
	Assigned []string `json:"assigned"`
}

type M1VerdictRequest struct {
	ObjectiveID string `json:"objectiveId"`
	TaskID string `json:"taskId"`
	ExpectedRevision int64 `json:"expectedRevision"`
	Accepted bool `json:"accepted"`
	VerificationEvidence string `json:"verificationEvidence"`
	ReviewEvidence string `json:"reviewEvidence"`
	DirectorNote string `json:"directorNote"`
}

func (m *M1Runtime) start(ctx context.Context) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ctx = ctx
	configDir, err := os.UserConfigDir()
	if err == nil {
		path := filepath.Join(configDir, "agentic-engineering", "v2")
		if err = os.MkdirAll(path, 0700); err == nil {
			m.runner, err = collaboration.Open(ctx, filepath.Join(path, "collaboration.sqlite"), filepath.Join(path, "evidence"))
		}
	}
	m.startErr = err
}

func (m *M1Runtime) stop(ctx context.Context) {
	m.mu.Lock()
	runner := m.runner
	m.runner = nil
	m.mu.Unlock()
	if runner == nil {
		return
	}
	// Persist terminal state and revoke credentials even when Wails' own
	// shutdown context has already been cancelled.
	shutdown, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	if err := runner.Close(shutdown); err != nil {
		fmt.Fprintln(os.Stderr, "M1 shutdown:", err)
	}
}

func (m *M1Runtime) ready() (*collaboration.Runner, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.runner != nil {
		return m.runner, nil
	}
	if m.startErr != nil {
		return nil, fmt.Errorf("M1 storage unavailable: %w", m.startErr)
	}
	return nil, errors.New("M1 runtime is not running")
}

func (m *M1Runtime) CreateM1Objective(req M1CreateRequest) (M1Objective, error) {
	r, err := m.ready()
	if err != nil {
		return M1Objective{}, err
	}
	ctx := m.ctx
	if req.Developer == req.Reviewer || !m1ValidProvider(req.Developer) || !m1ValidProvider(req.Reviewer) {
		return M1Objective{}, errors.New("assign Claude and Codex to different Developer/Reviewer roles")
	}
	if strings.TrimSpace(req.Title) == "" || strings.TrimSpace(req.AcceptanceCriteria) == "" ||
		len(req.Tasks) == 0 || len(req.Tasks) > 20 || req.WakeBudget < 0 || req.WakeBudget > 20 {
		return M1Objective{}, errors.New("title, acceptance criteria, 1–20 tasks and bounded wake budget required")
	}
	repository, err := m1GitRoot(ctx, req.Repository)
	if err != nil {
		return M1Objective{}, err
	}
	var participants []core.ParticipantInput
	for _, assignment := range []struct{ name, role string }{
		{req.Developer, "Developer"}, {req.Reviewer, "Reviewer"},
	} {
		worktree, err := m1AddWorktree(ctx, repository)
		if err != nil {
			// Preserve previously created worktrees for inspection instead
			// of deleting potentially valuable user files.
			return M1Objective{}, err
		}
		participants = append(participants, core.ParticipantInput{
			Agent: strings.ToLower(assignment.name), Role: assignment.role,
			Workdir: worktree,
		})
	}
	tasks := make([]core.TaskInput, 0, len(req.Tasks))
	for _, task := range req.Tasks {
		if strings.TrimSpace(task) == "" {
			return M1Objective{}, errors.New("task titles must not be empty")
		}
		tasks = append(tasks, core.TaskInput{Title: task})
	}
	project, err := r.Service().CreateProject(ctx, filepath.Base(repository), repository)
	if err != nil {
		return M1Objective{}, err
	}
	record, err := r.Service().CreateObjective(ctx, core.ObjectiveInput{
		ProjectID: project.ID, Title: req.Title,
		Description: req.Description, AcceptanceCriteria: req.AcceptanceCriteria,
		Participants: participants, Tasks: tasks, WakeBudget: req.WakeBudget,
	})
	if err != nil {
		return M1Objective{}, err
	}
	list, err := r.Service().ListParticipantRecords(ctx, record.ID)
	if err != nil {
		return M1Objective{}, err
	}
	return M1Objective{ID: record.ID, ProjectID: project.ID, Participants: list, Tasks: record.Tasks}, nil
}

func m1ValidProvider(name string) bool {
	return name == "Claude" || name == "Codex"
}

func m1GitRoot(ctx context.Context, directory string) (string, error) {
	if !filepath.IsAbs(directory) {
		return "", errors.New("select an absolute repository path")
	}
	absolute, err := filepath.EvalSymlinks(directory)
	if err != nil {
		return "", fmt.Errorf("resolve repository: %w", err)
	}
	output, err := exec.CommandContext(ctx, "git", "-C", absolute, "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return "", fmt.Errorf("repository is not a Git checkout: %w", err)
	}
	if filepath.Clean(strings.TrimSpace(string(output))) != filepath.Clean(absolute) {
		return "", errors.New("select the repository root, not a nested directory")
	}
	return absolute, nil
}

func m1AddWorktree(ctx context.Context, repo string) (string, error) {
	base := filepath.Join(repo, ".worktrees")
	if err := os.MkdirAll(base, 0700); err != nil {
		return "", fmt.Errorf("create worktree base: %w", err)
	}
	path, err := os.MkdirTemp(base, "m1-*")
	if err != nil {
		return "", err
	}
	if err := os.Remove(path); err != nil {
		return "", err
	}
	output, err := exec.CommandContext(ctx, "git", "-C", repo, "worktree", "add", "--detach", path, "HEAD").CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("create isolated worktree: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return path, nil
}

func (m *M1Runtime) RunM1Turn(req M1RunRequest) (collaboration.TurnReport, error) {
	r, err := m.ready()
	if err != nil {
		return collaboration.TurnReport{}, err
	}
	p, err := r.Service().GetParticipantRecord(m.ctx, req.ParticipantID)
	if err != nil {
		return collaboration.TurnReport{}, err
	}
	if strings.TrimSpace(req.KnowledgeRoot) == "" {
		return collaboration.TurnReport{}, errors.New("select local engineering-knowledge v1.0.0 root")
	}
	if strings.TrimSpace(req.Prompt) == "" || len(req.Prompt) > 64<<10 {
		return collaboration.TurnReport{}, errors.New("enter a bounded task prompt")
	}
	name := "Claude"
	if p.Agent == "codex" {
		name = "Codex"
	}
	status := discovery.Scan(name, "")
	if status.State != "Connected" {
		return collaboration.TurnReport{}, fmt.Errorf("%s native login not verified: %s", name, status.Diagnostic)
	}
	knowledge, err := BuildKnowledgeContext(m.ctx, KnowledgeContextRequest{
		RepositoryDir: p.Workdir, AgentID: p.Handle, Root: req.KnowledgeRoot,
		Role: p.Role, Languages: []string{"go", "typescript"}, Assigned: req.Assigned,
	})
	if err != nil {
		return collaboration.TurnReport{}, err
	}
	if knowledge.Directory != "" {
		defer func() { _ = os.RemoveAll(knowledge.Directory) }()
	}
	if knowledge.Version != "1.0.0" {
		return collaboration.TurnReport{}, fmt.Errorf("M1 is pinned to engineering-knowledge 1.0.0, found %s", knowledge.Version)
	}
	instructions := fmt.Sprintf(
		"You are the %s agent (%s) in a human-directed engineering objective. "+
			"Use the authenticated agentic_engineering MCP tools to read your objective, claim and update tasks, "+
			"send evidence-based handoffs and read messages. A submission is not acceptance. "+
			"Never bypass native permissions, modify another participant's worktree, or accept your own task.\n"+
			"Engineering Knowledge %s (pack status: %s, revision: %s). "+
			"Document status 'draft' remains provisional; approved rules remain binding.\n%s\n"+
			"On-demand references (read only when relevant): %s\n%s",
		p.Role, p.Handle, knowledge.Version, knowledge.Status, knowledge.Revision,
		knowledge.Bootstrap, knowledge.Directory, knowledge.Index,
	)
	prompt := req.Prompt
	if knowledge.Directory != "" {
		prompt = "Current on-demand knowledge directory: " + knowledge.Directory +
			" (previous temporary paths may have expired).\n" + prompt
	}
	return r.RunTurn(m.ctx, req.ParticipantID, core.TriggerHuman,
		prompt, instructions, agent.Binary{
			Kind: agent.Kind(p.Agent), Path: status.Path, Version: status.Version,
		}, func(event agent.Event) {
			if m.ctx != nil {
				wailsruntime.EventsEmit(m.ctx, "m1-native-event", map[string]any{
					"participantId": p.ID, "type": event.Type, "seq": event.Seq,
				})
			}
		})
}

func (m *M1Runtime) CancelM1Turn(participantID string) error {
	r, err := m.ready()
	if err != nil {
		return err
	}
	r.Cancel(participantID)
	return nil
}

func (m *M1Runtime) GetM1Snapshot(objectiveID string) (M1Snapshot, error) {
	r, err := m.ready()
	if err != nil {
		return M1Snapshot{}, err
	}
	participants, err := r.Service().ListParticipantRecords(m.ctx, objectiveID)
	if err != nil {
		return M1Snapshot{}, err
	}
	if len(participants) == 0 {
		return M1Snapshot{}, core.ErrNotFound
	}
	first := participants[0]
	objective, err := r.Service().GetObjective(m.ctx, core.Principal{
		ObjectiveID: objectiveID, Handle: first.Handle, Agent: first.Agent, Role: first.Role,
	})
	if err != nil {
		return M1Snapshot{}, err
	}
	messages, err := r.Service().ListMessages(m.ctx, objectiveID, 0, 200)
	if err != nil {
		return M1Snapshot{}, err
	}
	turns, err := r.Service().ListTurns(m.ctx, objectiveID, 100)
	if err != nil {
		return M1Snapshot{}, err
	}
	return M1Snapshot{Objective: objective, Participants: participants, Messages: messages, Turns: turns}, nil
}

func (m *M1Runtime) PostM1Message(objectiveID, toHandle, body string) (core.Message, error) {
	r, err := m.ready()
	if err != nil {
		return core.Message{}, err
	}
	return r.Service().PostHumanMessage(m.ctx, objectiveID, toHandle, body, "")
}

func (m *M1Runtime) SetM1Verdict(req M1VerdictRequest) (core.Task, error) {
	r, err := m.ready()
	if err != nil {
		return core.Task{}, err
	}
	if strings.TrimSpace(req.DirectorNote) == "" {
		return core.Task{}, errors.New("record an explicit Director decision")
	}
	if req.Accepted && (strings.TrimSpace(req.VerificationEvidence) == "" ||
		strings.TrimSpace(req.ReviewEvidence) == "") {
		return core.Task{}, errors.New("acceptance requires independent test and reviewer evidence")
	}
	summary := "Director decision: " + req.DirectorNote
	if req.Accepted {
		summary += "\nVerification: " + req.VerificationEvidence +
			"\nReviewer: " + req.ReviewEvidence
	}
	if len(summary) > core.MaxSummaryBytes {
		return core.Task{}, errors.New("verdict summary exceeds 4 KiB")
	}
	return r.Service().SetTaskVerdict(m.ctx, req.ObjectiveID, req.TaskID,
		req.ExpectedRevision, req.Accepted, summary)
}
