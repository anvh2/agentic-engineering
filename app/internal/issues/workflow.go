package issues

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/anvh2/agentic-engineering/app/internal/agent"
	"github.com/anvh2/agentic-engineering/app/internal/collaboration"
	"github.com/anvh2/agentic-engineering/app/internal/core"
	"github.com/anvh2/agentic-engineering/app/internal/workspace"
)

const (
	maxPatchPreview = 200 << 10
	captureTimeout  = 3 * time.Minute

	purposeImplement = "implement"
	purposeRevise    = "revise"
	purposeHandoff   = "complete handoff"
	purposeReview    = "review"
	purposeVerdict   = "complete verdict"
	purposeRespond   = "respond to Director"
)

// step is what the worker must do next.
type step int

const (
	stepImplement step = iota
	stepAnswerAssignee
	stepReview
	stepStopped
	stepDone
)

// execute drives an issue until its change is approved. The order is fixed:
// the assignee submits and hands off, the reviewer judges that exact
// snapshot, and requested changes return to the assignee.
func (s *Service) execute(ctx context.Context, e *execution) error {
	s.mu.Lock()
	prepared := e.prepared
	s.mu.Unlock()
	if !prepared {
		if err := s.prepare(ctx, e); err != nil {
			return err
		}
	}
	if err := s.deliverQueued(ctx, e); err != nil {
		return err
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		next := s.next(e)
		if next == stepDone {
			return nil
		}
		if next == stepStopped {
			return context.Canceled
		}
		var err error
		if next == stepImplement {
			err = s.implement(ctx, e)
		} else if next == stepAnswerAssignee {
			err = s.answer(ctx, e)
		} else {
			err = s.review(ctx, e)
		}
		if err != nil {
			return err
		}
	}
}

// next decides the next step. Completion is published under the same lock that
// reads the pending comments, so a comment can never be lost between them.
func (s *Service) next(e *execution) step {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e.view.Phase == PhaseStopping {
		return stepStopped
	}
	if !e.submitted {
		return stepImplement
	}
	if len(e.pending[core.DutyAssignee]) > 0 {
		return stepAnswerAssignee
	}
	if e.verdict != core.VerdictApproved || len(e.pending[core.DutyReviewer]) > 0 {
		return stepReview
	}
	e.running = false
	e.view.Phase, e.view.Detail = PhaseInReview, "Waiting for the Director"
	s.recordLocked(e, "lifecycle", "Runtime", "Implementation and independent review complete; waiting for the Director")
	s.changedLocked(e)
	return stepDone
}

// prepare verifies both agents can run, creates their worktrees for every
// linked repository and records the objective.
func (s *Service) prepare(ctx context.Context, e *execution) error {
	logger := s.log.WithName("Service.prepare").WithValues("issue_id", e.request.IssueID)
	members := []*participant{&e.assignee, &e.reviewer}
	dirs := make([]string, 0, len(e.request.Repositories))
	for _, r := range e.request.Repositories {
		dirs = append(dirs, r.Path)
	}

	s.progress(e, PhasePreparing, "Verifying native harness logins")
	for _, p := range members {
		if _, err := s.harness(ctx, p.profile.Harness); err != nil {
			logger.Error(err, "Harness", "harness", p.profile.Harness)
			return fmt.Errorf("%s: %w", p.profile.Name, err)
		}
	}
	s.progress(e, PhasePreparing, "Loading engineering knowledge")
	for _, p := range members {
		knowledge, err := s.knowledge(ctx, p.profile, dirs)
		if err != nil {
			logger.Error(err, "Knowledge", "agent_id", p.profile.ID)
			return fmt.Errorf("%s: %w", p.profile.Name, err)
		}
		if knowledge.Release != nil {
			knowledge.Release()
		}
	}

	s.progress(e, PhasePreparing, "Creating isolated worktrees")
	if err := s.createWorktrees(ctx, e); err != nil {
		return err
	}

	project, err := s.store.CreateProject(ctx, projectName(e.request), "Working issue execution")
	if err != nil {
		logger.Error(err, "Store.CreateProject")
		return err
	}
	input := core.ObjectiveInput{
		ProjectID: project.ID, Title: e.request.Title, Description: e.request.Description,
		AcceptanceCriteria: e.request.AcceptanceCriteria,
		Tasks:              []core.TaskInput{{Title: e.request.Title, Description: "Implement the issue and hand it off for independent review."}},
		// The service is the only driver: automatic wakes would race it.
		WakeBudget: 0,
	}
	for _, p := range members {
		input.Participants = append(input.Participants, core.ParticipantInput{
			Agent: strings.ToLower(p.profile.Harness), AgentID: p.profile.ID, Name: p.profile.Name,
			Handle: p.profile.Handle, Role: p.profile.Role, Duty: p.duty, Model: p.profile.Model,
			KnowledgeRoot: p.profile.KnowledgeRoot, Languages: p.profile.Languages,
			Assigned: p.profile.Assigned, Workdir: p.checkouts[0].Dir,
		})
	}
	objective, err := s.store.CreateObjective(ctx, input)
	if err != nil {
		logger.Error(err, "Store.CreateObjective")
		return err
	}
	for _, p := range members {
		p.id = objective.Participants[p.profile.Handle]
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	e.view.ObjectiveID, e.prepared = objective.ID, true
	s.recordLocked(e, "lifecycle", "Runtime", fmt.Sprintf("Prepared isolated worktrees for %d repositories", len(e.request.Repositories)))
	s.changedLocked(e)
	return nil
}

var labelPattern = regexp.MustCompile(`[^a-z0-9]+`)

func (s *Service) createWorktrees(ctx context.Context, e *execution) error {
	logger := s.log.WithName("Service.createWorktrees").WithValues("issue_id", e.request.IssueID)
	s.worktreeMu.Lock()
	defer s.worktreeMu.Unlock()
	label := strings.Trim(labelPattern.ReplaceAllString(strings.ToLower(e.request.IssueKey), "-"), "-")
	if label == "" || len(label) > 24 {
		label = "issue"
	}
	var created []workspace.Checkout
	for _, p := range []*participant{&e.assignee, &e.reviewer} {
		p.checkouts = nil
		for _, repository := range e.request.Repositories {
			checkout, err := workspace.Create(ctx, repository, "ae-"+label+"-"+string(p.duty))
			if err == nil {
				created = append(created, checkout)
				p.checkouts = append(p.checkouts, checkout)
				continue
			}
			logger.Error(err, "workspace.Create", "repository", repository.Name)
			// Nothing ran in these worktrees yet, so removing them is safe.
			cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), captureTimeout)
			defer cancel()
			for _, done := range created {
				if removeErr := workspace.Discard(cleanup, done); removeErr != nil {
					logger.Error(removeErr, "workspace.Discard", "path", done.Dir)
				}
			}
			return err
		}
	}
	// Both participants must start from the same commit of each repository,
	// even when the checkout moved between the two calls.
	for i := range e.reviewer.checkouts {
		e.reviewer.checkouts[i].Base = e.assignee.checkouts[i].Base
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range e.view.Repositories {
		e.view.Repositories[i].BaseCommit = e.assignee.checkouts[i].Base
		e.view.Repositories[i].AssigneeDir = e.assignee.checkouts[i].Dir
		e.view.Repositories[i].ReviewerDir = e.reviewer.checkouts[i].Dir
	}
	return nil
}

// deliverQueued posts Director comments written before the objective existed.
func (s *Service) deliverQueued(ctx context.Context, e *execution) error {
	logger := s.log.WithName("Service.deliverQueued").WithValues("issue_id", e.request.IssueID)
	for {
		s.mu.Lock()
		if len(e.queued) == 0 {
			s.mu.Unlock()
			return nil
		}
		body, objectiveID := e.queued[0], e.view.ObjectiveID
		targets := e.mentioned(body)
		s.mu.Unlock()
		to := ""
		if len(targets) == 1 {
			to = targets[0].profile.Handle
		}
		if _, err := s.store.PostHumanMessage(ctx, objectiveID, to, body, ""); err != nil {
			logger.Error(err, "Store.PostHumanMessage")
			return fmt.Errorf("deliver Director comment: %w", err)
		}
		s.mu.Lock()
		e.queued = e.queued[1:]
		for _, p := range targets {
			e.pending[p.duty] = append(e.pending[p.duty], body)
		}
		s.changedLocked(e)
		s.mu.Unlock()
	}
}

// implement runs the assignee until the change is submitted, handed off and
// captured.
func (s *Service) implement(ctx context.Context, e *execution) error {
	s.mu.Lock()
	revising := e.verdict == core.VerdictChangesRequested
	s.mu.Unlock()
	purpose, phase, prompt := purposeImplement, PhaseImplementing, implementPrompt(e)
	if revising {
		purpose, phase, prompt = purposeRevise, PhaseRevising, revisePrompt(e)
	}
	before, err := s.lastMessage(ctx, e)
	if err != nil {
		return err
	}
	if _, err := s.turn(ctx, e, &e.assignee, phase, purpose, prompt); err != nil {
		return err
	}
	return s.requireHandoff(ctx, e, before)
}

// answer lets the assignee respond to the Director. A change to the code
// withdraws the approval and needs a new handoff.
func (s *Service) answer(ctx context.Context, e *execution) error {
	before, err := s.lastMessage(ctx, e)
	if err != nil {
		return err
	}
	s.mu.Lock()
	reviewed := slices.Clone(e.trees)
	s.mu.Unlock()
	if _, err := s.turn(ctx, e, &e.assignee, PhaseResponding, purposeRespond, respondPrompt()); err != nil {
		s.withdrawIfChanged(e, reviewed)
		return err
	}
	if !s.withdrawIfChanged(e, reviewed) {
		return nil
	}
	return s.requireHandoff(ctx, e, before)
}

// withdrawIfChanged drops the handoff and approval when the captured content
// differs from what was handed off.
func (s *Service) withdrawIfChanged(e *execution, reviewed []string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if slices.Equal(reviewed, e.trees) {
		return false
	}
	e.submitted, e.verdict, e.view.ApprovedReview = false, "", ""
	s.recordLocked(e, "lifecycle", "Runtime", "Implementation changed; the previous review no longer applies")
	s.changedLocked(e)
	return true
}

// requireHandoff verifies, from durable records, that the assignee submitted
// the task and messaged the reviewer after the given message. One reminder turn
// is allowed.
func (s *Service) requireHandoff(ctx context.Context, e *execution, before int64) error {
	missing, err := s.missingHandoff(ctx, e, before)
	if err != nil {
		return err
	}
	if missing != "" {
		if _, err := s.turn(ctx, e, &e.assignee, PhaseImplementing, purposeHandoff, handoffPrompt(e, missing)); err != nil {
			return err
		}
		if missing, err = s.missingHandoff(ctx, e, before); err != nil {
			return err
		}
	}
	if missing != "" {
		return fmt.Errorf("%s did not complete the handoff: %s", e.assignee.profile.Name, missing)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	changed := false
	for _, r := range e.view.Repositories {
		changed = changed || len(r.Files) > 0
	}
	if !changed {
		return fmt.Errorf("%s submitted no change in any linked repository", e.assignee.profile.Name)
	}
	e.submitted, e.verdict, e.view.ApprovedReview = true, "", ""
	s.recordLocked(e, "handoff", e.assignee.profile.Name, "Submitted the implementation and sent a handoff to @"+e.reviewer.profile.Handle)
	s.changedLocked(e)
	return nil
}

func (s *Service) missingHandoff(ctx context.Context, e *execution, before int64) (string, error) {
	logger := s.log.WithName("Service.missingHandoff").WithValues("issue_id", e.request.IssueID)
	tasks, err := s.store.ListTasks(ctx, e.view.ObjectiveID)
	if err != nil {
		logger.Error(err, "Store.ListTasks")
		return "", err
	}
	var missing []string
	if len(tasks) != 1 || tasks[0].Status != core.TaskSubmitted || tasks[0].Owner != e.assignee.profile.Handle {
		missing = append(missing, "the task is not submitted by you with update_task")
	}
	messages, err := s.store.ListMessages(ctx, e.view.ObjectiveID, before, 0)
	if err != nil {
		logger.Error(err, "Store.ListMessages")
		return "", err
	}
	sent := slices.ContainsFunc(messages, func(m core.Message) bool {
		return m.From == e.assignee.profile.Handle && (m.To == e.reviewer.profile.Handle || m.To == "")
	})
	if !sent {
		missing = append(missing, "no handoff message to @"+e.reviewer.profile.Handle+" was sent with send_message")
	}
	return strings.Join(missing, "; "), nil
}

// review runs the independent reviewer on the captured snapshot.
func (s *Service) review(ctx context.Context, e *execution) error {
	logger := s.log.WithName("Service.review").WithValues("issue_id", e.request.IssueID)
	s.mu.Lock()
	commits := make([]string, len(e.view.Repositories))
	for i, r := range e.view.Repositories {
		commits[i] = r.SnapshotCommit
	}
	trees := slices.Clone(e.trees)
	answering := e.verdict == core.VerdictApproved
	s.mu.Unlock()
	for i, checkout := range e.reviewer.checkouts {
		if err := checkout.Show(ctx, commits[i]); err != nil {
			logger.Error(err, "workspace.Show", "repository", checkout.Repository.Name)
			return err
		}
	}
	purpose, phase, prompt := purposeReview, PhaseReviewing, reviewPrompt(e, commits)
	if answering {
		purpose, phase, prompt = purposeRespond, PhaseResponding, respondPrompt()
	}
	verdict, err := s.reviewTurn(ctx, e, phase, purpose, prompt)
	if err != nil {
		return err
	}
	if verdict == nil && !answering {
		verdict, err = s.reviewTurn(ctx, e, PhaseReviewing, purposeVerdict, verdictPrompt())
		if err != nil {
			return err
		}
	}
	if verdict == nil && !answering {
		return fmt.Errorf("%s did not submit a review verdict", e.reviewer.profile.Name)
	}
	if err := s.verifyUnchanged(ctx, e, trees); err != nil {
		s.mu.Lock()
		e.submitted, e.verdict, e.view.ApprovedReview = false, "", ""
		s.mu.Unlock()
		return fmt.Errorf("verdict discarded: %w", err)
	}
	if verdict == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	defer s.changedLocked(e)
	e.view.ReviewRounds++
	e.verdict = verdict.Verdict
	if verdict.Verdict == core.VerdictApproved {
		e.view.ApprovedReview = verdict.ID
		s.recordLocked(e, "review", e.reviewer.profile.Name, "Approved the submitted change")
		return nil
	}
	e.submitted, e.view.ApprovedReview = false, ""
	s.recordLocked(e, "review", e.reviewer.profile.Name, "Requested changes")
	if e.view.ReviewRounds >= s.maxRounds {
		return fmt.Errorf("review still requests changes after %d rounds; comment with guidance and retry", e.view.ReviewRounds)
	}
	return nil
}

// reviewTurn runs one reviewer turn and returns the verdict that turn
// recorded, or nil when it recorded none.
func (s *Service) reviewTurn(ctx context.Context, e *execution, phase Phase, purpose, prompt string) (*core.Review, error) {
	logger := s.log.WithName("Service.reviewTurn").WithValues("issue_id", e.request.IssueID)
	report, err := s.turn(ctx, e, &e.reviewer, phase, purpose, prompt)
	if err != nil {
		return nil, err
	}
	reviews, err := s.store.ListReviews(ctx, e.view.ObjectiveID)
	if err != nil {
		logger.Error(err, "Store.ListReviews")
		return nil, err
	}
	for _, review := range slices.Backward(reviews) {
		if review.TurnID == report.TurnID {
			return &review, nil
		}
	}
	return nil, nil
}

// verifyUnchanged refuses a verdict or acceptance when the assignee's
// worktrees no longer hold the captured content.
func (s *Service) verifyUnchanged(ctx context.Context, e *execution, trees []string) error {
	logger := s.log.WithName("Service.verifyUnchanged").WithValues("issue_id", e.request.IssueID)
	if len(trees) != len(e.assignee.checkouts) {
		return ErrStale
	}
	for i, checkout := range e.assignee.checkouts {
		tree, err := checkout.Tree(ctx)
		if err != nil {
			logger.Error(err, "workspace.Tree", "repository", checkout.Repository.Name)
			return err
		}
		if tree != trees[i] {
			return fmt.Errorf("%w in %s", ErrStale, checkout.Repository.Name)
		}
	}
	return nil
}

func (s *Service) lastMessage(ctx context.Context, e *execution) (int64, error) {
	logger := s.log.WithName("Service.lastMessage").WithValues("issue_id", e.request.IssueID)
	var last int64
	for {
		messages, err := s.store.ListMessages(ctx, e.view.ObjectiveID, last, 0)
		if err != nil {
			logger.Error(err, "Store.ListMessages")
			return 0, err
		}
		if len(messages) == 0 {
			return last, nil
		}
		last = messages[len(messages)-1].Seq
	}
}

// turn runs one native turn of a participant. Pending Director comments for the
// participant travel in the prompt and are restored when the turn fails. After
// every assignee turn the actual worktree change is captured.
func (s *Service) turn(ctx context.Context, e *execution, p *participant, phase Phase, purpose, prompt string) (collaboration.TurnReport, error) {
	logger := s.log.WithName("Service.turn").WithValues("issue_id", e.request.IssueID, "agent_id", p.profile.ID, "purpose", purpose)
	var none collaboration.TurnReport
	s.progress(e, phase, fmt.Sprintf("%s: %s", p.profile.Name, purpose))
	binary, err := s.harness(ctx, p.profile.Harness)
	if err != nil {
		logger.Error(err, "Harness")
		return none, fmt.Errorf("%s: %w", p.profile.Name, err)
	}
	dirs := make([]string, 0, len(p.checkouts))
	for _, c := range p.checkouts {
		dirs = append(dirs, c.Dir)
	}
	knowledge, err := s.knowledge(ctx, p.profile, dirs)
	if err != nil {
		logger.Error(err, "Knowledge")
		return none, fmt.Errorf("%s: %w", p.profile.Name, err)
	}
	if knowledge.Release != nil {
		defer knowledge.Release()
	}
	addDirs := slices.Clone(dirs[1:])
	if knowledge.Directory != "" {
		addDirs = append(addDirs, knowledge.Directory)
		prompt += "\n\nOn-demand knowledge is available for this turn in: " + knowledge.Directory
	}

	s.mu.Lock()
	comments := e.pending[p.duty]
	delete(e.pending, p.duty)
	s.mu.Unlock()
	if len(comments) > 0 {
		prompt += "\n\nDirector message(s) for you. Address them and reply with send_message to \"human\":\n- " + strings.Join(comments, "\n- ")
	}
	access := agent.AccessImplement
	if p.duty == core.DutyReviewer {
		access = agent.AccessReview
	}

	var turnID string
	observer := agent.NewObserver(agent.Kind(strings.ToLower(p.profile.Harness)))
	report, err := s.turns.RunTurn(ctx, collaboration.TurnRequest{
		ParticipantID: p.id, Trigger: core.TriggerHuman, Prompt: prompt,
		Instructions: instructions(e, p, knowledge), Binary: binary, Access: access, AddDirs: addDirs,
		OnStart: func(id, _ string) {
			turnID = id
			s.mu.Lock()
			defer s.mu.Unlock()
			e.view.Runs = append(e.view.Runs, Run{
				TurnID: id, Duty: p.duty, AgentID: p.profile.ID, AgentName: p.profile.Name,
				Harness: p.profile.Harness, Purpose: purpose, State: "running", StartedAt: now(),
				Usage: []Usage{}, KnowledgeVersion: knowledge.Version, KnowledgeRevision: knowledge.Revision,
			})
			s.recordLocked(e, "run", p.profile.Name, fmt.Sprintf("Started %s run on %s", purpose, p.profile.Harness))
			s.changedLocked(e)
		},
		OnEvent: func(event agent.Event) { s.observed(e, p, turnID, observer.Observe(event)) },
	})
	if err != nil {
		logger.Error(err, "Turns.RunTurn")
	}
	s.finishRun(e, p, turnID, report, err)

	var captureErr error
	if p.duty == core.DutyAssignee {
		// Capture partial work even when the turn was stopped or failed.
		captureCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), captureTimeout)
		defer cancel()
		captureErr = s.capture(captureCtx, e)
	}
	if err == nil && report.State != "succeeded" {
		err = errors.New(report.Error)
	}
	if err != nil {
		s.mu.Lock()
		if len(comments) > 0 {
			e.pending[p.duty] = append(comments, e.pending[p.duty]...)
		}
		s.mu.Unlock()
		return report, fmt.Errorf("%s %s run did not succeed: %w", p.profile.Name, purpose, err)
	}
	return report, captureErr
}

// observed adds native actions to the execution while the turn runs.
func (s *Service) observed(e *execution, p *participant, turnID string, observations []agent.Observation) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range e.view.Runs {
		if e.view.Runs[i].TurnID == turnID {
			e.view.Runs[i].Events++
		}
	}
	for _, o := range observations {
		if o.Kind == agent.ObservedCommand || (o.Kind == agent.ObservedDenied && o.Command != "") {
			e.view.Commands = append(e.view.Commands, Command{
				TurnID: turnID, Duty: p.duty, AgentName: p.profile.Name, Command: o.Command,
				ExitCode: o.ExitCode, Failed: o.Failed, Background: o.Background,
				Test:   o.Kind == agent.ObservedCommand && isTestCommand(o.Command),
				Output: o.Output, At: now(),
			})
			if over := len(e.view.Commands) - maxCommands; over > 0 {
				e.view.Commands = slices.Delete(e.view.Commands, 0, over)
			}
		}
		s.recordLocked(e, string(o.Kind), p.profile.Name, describe(o))
	}
	if len(observations) > 0 {
		s.changedLocked(e)
	}
}

func (s *Service) finishRun(e *execution, p *participant, turnID string, report collaboration.TurnReport, runErr error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	defer s.changedLocked(e)
	state, message := report.State, report.Error
	if runErr != nil {
		state, message = "failed", runErr.Error()
	}
	for i := range e.view.Runs {
		run := &e.view.Runs[i]
		if run.TurnID != turnID {
			continue
		}
		run.State, run.Error, run.EndedAt = state, message, now()
		run.FinalText, run.ToolFailures = report.FinalText, report.ToolFailures
		run.EvidencePath, run.EvidenceSHA256 = report.EvidencePath, report.EvidenceSHA256
		run.NativeSessionID = report.NativeSessionID
	}
	text := "Run " + state
	if message != "" {
		text += ": " + message
	}
	s.recordLocked(e, "run", p.profile.Name, text)
}

// capture records the assignee's actual change in every linked repository.
func (s *Service) capture(ctx context.Context, e *execution) error {
	logger := s.log.WithName("Service.capture").WithValues("issue_id", e.request.IssueID)
	snapshots := make([]workspace.Snapshot, len(e.assignee.checkouts))
	paths := make([]string, len(e.assignee.checkouts))
	for i, checkout := range e.assignee.checkouts {
		snapshot, err := checkout.Capture(ctx, "Agentic Engineering snapshot: "+e.request.IssueKey+" "+e.request.Title)
		if err != nil {
			logger.Error(err, "workspace.Capture", "repository", checkout.Repository.Name)
			return fmt.Errorf("capture change in %s: %w", checkout.Repository.Name, err)
		}
		snapshots[i] = snapshot
		if !snapshot.Changed() {
			continue
		}
		paths[i] = filepath.Join(s.evidenceDir, e.view.ObjectiveID+"-"+snapshot.Commit+".patch")
		if err := os.WriteFile(paths[i], []byte(snapshot.Patch), 0600); err != nil {
			logger.Error(err, "os.WriteFile", "path", paths[i])
			return fmt.Errorf("write patch evidence: %w", err)
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	e.trees = make([]string, len(snapshots))
	for i, snapshot := range snapshots {
		e.trees[i] = snapshot.Tree
		state := &e.view.Repositories[i]
		state.SnapshotCommit, state.Files, state.PatchPath = snapshot.Commit, snapshot.Files, paths[i]
		state.Patch, state.PatchSHA256, state.PatchTruncated = snapshot.Patch, snapshot.PatchSHA256, false
		if len(state.Patch) > maxPatchPreview {
			state.Patch, state.PatchTruncated = strings.ToValidUTF8(state.Patch[:maxPatchPreview], ""), true
		}
		if !snapshot.Changed() {
			state.PatchSHA256 = ""
		}
	}
	s.changedLocked(e)
	return nil
}

func (s *Service) progress(e *execution, phase Phase, detail string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e.view.Phase == PhaseStopping {
		return
	}
	e.view.Phase, e.view.Detail = phase, detail
	s.changedLocked(e)
}

func projectName(req StartRequest) string {
	if name := strings.TrimSpace(req.ProjectName); name != "" {
		return name
	}
	return req.ProjectID
}

func instructions(e *execution, p *participant, k Knowledge) string {
	peer, duty, peerDuty := &e.reviewer, "ASSIGNEE (implementation)", "independent reviewer"
	if p.duty == core.DutyReviewer {
		peer, duty, peerDuty = &e.assignee, "INDEPENDENT REVIEWER", "assignee"
	}
	var repositories strings.Builder
	for _, c := range p.checkouts {
		fmt.Fprintf(&repositories, "- %s: %s (base commit %s)\n", c.Repository.Name, c.Dir, c.Base)
	}
	return fmt.Sprintf(`You are %s (@%s), a Team agent with the role %s. On this objective your duty is %s.
Your teammate is %s (@%s), the %s. "human" is the Director, who alone accepts work.

Collaborate only through the agentic_engineering MCP tools (get_objective, read_messages, send_message, claim_task, update_task, submit_review).

Repositories of this objective. These are your own isolated worktrees:
%s
Rules:
- Work only inside these worktrees. Do not commit, push, merge, rebase or switch branches; the application records your changes.
- Read each repository's AGENTS.md or CLAUDE.md, when present, before working in it.
- Never bypass native permissions or sandboxes. If a command is refused, use a simpler command (one command per call) or report the limitation.
- Report only commands you actually ran, with their observed results.

Engineering Knowledge %s (pack status: %s, revision: %s). Documents marked draft are provisional; approved rules are binding.
%s
On-demand knowledge index (read a document only when relevant):
%s`,
		p.profile.Name, p.profile.Handle, p.profile.Role, duty,
		peer.profile.Name, peer.profile.Handle, peerDuty,
		repositories.String(), k.Version, k.Status, k.Revision, k.Bootstrap, k.Index)
}

func implementPrompt(e *execution) string {
	return fmt.Sprintf(`Implement the issue now.
1. Call get_objective, then read_messages.
2. Claim the task with claim_task (or, if you already own it, set it to in_progress with update_task).
3. Make the change in your worktrees, in every repository the issue requires.
4. Run the relevant tests and fix what fails.
5. Call update_task with status "submitted" and a summary listing changed files, the exact test commands you ran with their results, and known gaps.
6. Call send_message to "%s" with a handoff: what changed, where, and how to verify it.`, e.reviewer.profile.Handle)
}

func revisePrompt(e *execution) string {
	return fmt.Sprintf(`The independent reviewer requested changes.
1. Call get_objective and read_messages to get the findings.
2. Address each finding, or explain why you will not.
3. Rerun the relevant tests.
4. Set the task to in_progress and then "submitted" with update_task, with new test evidence.
5. Call send_message to "%s" with a new handoff.`, e.reviewer.profile.Handle)
}

func handoffPrompt(e *execution, missing string) string {
	return fmt.Sprintf(`Your handoff is incomplete: %s.
Do not redo finished work. Verify your change, call update_task with status "submitted" and your test evidence, and call send_message to "%s" with the handoff.`,
		missing, e.reviewer.profile.Handle)
}

func reviewPrompt(e *execution, commits []string) string {
	var changes strings.Builder
	for i, c := range e.reviewer.checkouts {
		fmt.Fprintf(&changes, "- %s: in %s run `git diff %s %s`\n", c.Repository.Name, c.Dir, c.Base, commits[i])
	}
	return fmt.Sprintf(`Independently review the change submitted by "%s".
1. Call get_objective and read_messages to read the handoff.
2. The exact submitted change is checked out in your worktrees:
%s3. Check it against the acceptance criteria, look for defects, and run the tests yourself. Do not modify the implementation.
4. Finish by calling submit_review once: verdict "approved" or "changes_requested", your findings in summary, and the commands you ran with their results in verification. Request changes for any blocking defect.`,
		e.assignee.profile.Handle, changes.String())
}

func verdictPrompt() string {
	return `You have not recorded a verdict. Finish your review and call submit_review with "approved" or "changes_requested", a summary and your verification.`
}

func respondPrompt() string {
	return `The Director sent you a message. Call read_messages if needed, handle the request within your duty, and reply with send_message to "human".`
}
