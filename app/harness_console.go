package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/anvh2/agentic-engineering/app/internal/discovery"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	nativePromptLimit = 262144
	nativeRunTimeout  = 20 * time.Minute
)

type ConsoleResult struct {
	Output                 string                `json:"output"`
	Error                  string                `json:"error"`
	Usage                  *TokenUsage           `json:"usage,omitempty"`
	RunID                  string                `json:"runId,omitempty"`
	EstimatedContextTokens int64                 `json:"estimatedContextTokens,omitempty"`
	KnowledgeEvents        []KnowledgeTraceEvent `json:"knowledgeEvents,omitempty"`
}

type HarnessConsole struct {
	ctx    context.Context
	mu     sync.Mutex
	active map[string]context.CancelFunc
}

func consoleTarget(name, path, dir string) (string, string, error) {
	if name != "Claude" && name != "Codex" {
		return "", "", errors.New("unsupported native harness")
	}
	if strings.HasPrefix(dir, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", "", fmt.Errorf("find home directory: %w", err)
		}
		dir = filepath.Join(home, dir[2:])
	}
	if !filepath.IsAbs(dir) {
		return "", "", errors.New("choose an absolute working directory")
	}
	info, err := os.Stat(dir)
	if err != nil {
		return "", "", fmt.Errorf("inspect working directory: %w", err)
	}
	if !info.IsDir() {
		return "", "", errors.New("working directory is not a directory")
	}
	status := discovery.Scan(name, path)
	if status.State != "Connected" {
		return "", "", errors.New("native authentication not verified")
	}
	return status.Path, dir, nil
}

func (h *HarnessConsole) rootContext() context.Context {
	if h.ctx != nil {
		return h.ctx
	}
	return context.TODO()
}

func (h *HarnessConsole) BrowseRepository() (string, error) {
	if h.ctx == nil {
		return "", errors.New("desktop is not ready")
	}
	return runtime.OpenDirectoryDialog(h.ctx, runtime.OpenDialogOptions{Title: "Choose local repository"})
}

func (h *HarnessConsole) CurrentRepository() string {
	output, err := exec.CommandContext(h.rootContext(), "git", "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func (h *HarnessConsole) RunPrompt(name, path, dir, prompt string) ConsoleResult {
	return h.runPrompt(name, path, dir, prompt, "", "", "", nil)
}

func (h *HarnessConsole) RunIssuePrompt(name, path, dir, key, prompt string) ConsoleResult {
	if strings.TrimSpace(dir) == "" || strings.TrimSpace(key) == "" {
		return ConsoleResult{Error: "issue repository and key required"}
	}
	return h.runPrompt(name, path, dir, prompt, key, "", "", nil)
}

func (h *HarnessConsole) beginRun(name string) (context.Context, func(), error) {
	ctx, cancel := context.WithTimeout(h.rootContext(), nativeRunTimeout)
	h.mu.Lock()
	if h.active == nil {
		h.active = make(map[string]context.CancelFunc)
	}
	if h.active[name] != nil {
		h.mu.Unlock()
		cancel()
		return nil, nil, errors.New("harness already running")
	}
	h.active[name] = cancel
	h.mu.Unlock()
	end := func() {
		cancel()
		h.mu.Lock()
		delete(h.active, name)
		h.mu.Unlock()
	}
	return ctx, end, nil
}

func prepareIssueWorktree(ctx context.Context, dir, key string) (string, error) {
	root, err := exec.CommandContext(ctx, "git", "-C", dir, "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return "", errors.New("issue execution requires a Git repository")
	}
	rootDir := strings.TrimSpace(string(root))
	if filepath.Clean(rootDir) != filepath.Clean(dir) {
		return "", errors.New("select the repository root")
	}
	base := filepath.Join(rootDir, ".worktrees")
	if err := os.MkdirAll(base, 0700); err != nil {
		return "", fmt.Errorf("create worktree directory: %w", err)
	}
	sum := sha256.Sum256([]byte(key))
	work, err := os.MkdirTemp(base, fmt.Sprintf("issue-%x-", sum[:5]))
	if err != nil {
		return "", fmt.Errorf("reserve worktree path: %w", err)
	}
	if err := os.Remove(work); err != nil {
		return "", fmt.Errorf("release worktree path: %w", err)
	}
	output, err := exec.CommandContext(ctx, "git", "-C", rootDir, "worktree", "add", "--detach", work, "HEAD").CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("create isolated worktree: %s: %w", strings.TrimSpace(string(output)), err)
	}
	return work, nil
}

func nativeArgs(name, key, model string, standalone bool) []string {
	var args []string
	if name == "Claude" {
		args = []string{"-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"}
		if key == "" {
			args = append([]string{"-p", "--tools", "Read,Grep,Glob"}, args[1:]...)
		}
	} else {
		sandbox := "read-only"
		if key != "" {
			sandbox = "workspace-write"
		}
		args = []string{"exec", "--sandbox", sandbox, "--json"}
		if standalone {
			args = append(args, "--skip-git-repo-check")
		}
		args = append(args, "-")
	}
	if model != "" && model != "Default" {
		args = append([]string{args[0], "--model", model}, args[1:]...)
	}
	return args
}

// runPrompt controls the native process lifetime; onStart is invoked only after
// the CLI has successfully started, so the trace never claims an injection for
// an unavailable executable.
func (h *HarnessConsole) runPrompt(name, path, dir, prompt, key, model, knowledgeDir string, onStart func()) ConsoleResult {
	if strings.TrimSpace(prompt) == "" || len(prompt) > nativePromptLimit {
		return ConsoleResult{Error: "prompt is empty or too long"}
	}
	ctx, finish, err := h.beginRun(name)
	if err != nil {
		return ConsoleResult{Error: err.Error()}
	}
	defer finish()

	standalone := strings.TrimSpace(dir) == ""
	if standalone && knowledgeDir != "" {
		dir = knowledgeDir
	} else if standalone {
		dir, err = os.MkdirTemp("", "ae-chat-*")
		if err != nil {
			return ConsoleResult{Error: err.Error()}
		}
		// Session data is ephemeral by design until persistent sessions are introduced.
		defer func() { _ = os.RemoveAll(dir) }()
	}
	path, dir, err = consoleTarget(name, path, dir)
	if err != nil {
		return ConsoleResult{Error: err.Error()}
	}
	if key != "" {
		dir, err = prepareIssueWorktree(ctx, dir, key)
		if err != nil {
			return ConsoleResult{Error: err.Error()}
		}
		prompt = "Working in isolated worktree: " + dir + "\n" + prompt
	}
	args := nativeArgs(name, key, model, standalone)
	if name == "Claude" && knowledgeDir != "" && !standalone {
		args = append(args, "--add-dir", knowledgeDir)
	}
	command := exec.CommandContext(ctx, path, args...)
	command.Dir = dir
	command.Stdin = strings.NewReader(prompt)
	command.Env = append(os.Environ(), "PATH="+filepath.Dir(path)+":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:"+os.Getenv("PATH"))

	var stderr bytes.Buffer
	stream := &chatStream{
		name: name,
		emit: func(kind, body string) {
			if h.ctx != nil {
				runtime.EventsEmit(h.ctx, "native-chat", map[string]string{
					"name": name,
					"kind": kind,
					"body": body,
				})
			}
		},
	}
	// Chat uses ACP by default; issue execution retains its isolated worktree runtime.
	if key == "" && os.Getenv("AE_CHAT_RUNTIME") != "legacy" {
		if model != "" && model != "Default" {
			return ConsoleResult{Error: "ACP model selection is not implemented; select Default"}
		}
		return runACPChat(ctx, name, path, dir, prompt, stream, onStart)
	}
	command.Stdout = stream
	command.Stderr = &stderr
	err = command.Start()
	if err == nil {
		if onStart != nil {
			onStart()
		}
		err = command.Wait()
	}
	stream.flush()
	result := ConsoleResult{Output: stream.answer.String(), Usage: stream.usage}
	if key != "" {
		result.Output += "\n\nWorktree: " + dir
	}
	if ctx.Err() != nil {
		result.Error = "prompt cancelled or timed out"
	} else if err != nil {
		result.Error = "native CLI failed; use Terminal for diagnostics and approvals"
		if diagnostic := strings.TrimSpace(stderr.String()); diagnostic != "" {
			if len(diagnostic) > 2000 {
				diagnostic = diagnostic[:2000]
			}
			result.Error += "\n" + diagnostic
		}
	}
	return result
}

func (h *HarnessConsole) StopPrompt(name string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if cancel := h.active[name]; cancel != nil {
		cancel()
	}
}

func (h *HarnessConsole) stopAll() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, cancel := range h.active {
		cancel()
	}
}

func (h *HarnessConsole) OpenTerminal(name, path, dir string) error {
	path, dir, err := consoleTarget(name, path, dir)
	if err != nil {
		return err
	}
	quote := func(value string) string {
		return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
	}
	command := "cd " + quote(dir) + " && " + quote(path)
	return exec.CommandContext(
		h.rootContext(), "osascript",
		"-e", "on run argv",
		"-e", "tell application \"Terminal\" to do script (item 1 of argv)",
		"-e", "tell application \"Terminal\" to activate",
		"-e", "end run", command,
	).Run()
}

// RunAgentContextTest chooses exactly the applicable bootstrap documents and
// exposes only assigned on-demand files via the native harness workspace.
func (h *HarnessConsole) RunAgentContextTest(name, path, model string, request KnowledgeContextRequest, prompt string) ConsoleResult {
	if strings.TrimSpace(prompt) == "" {
		return ConsoleResult{Error: "enter a test message"}
	}
	knowledge, err := BuildKnowledgeContext(h.rootContext(), request)
	if err != nil {
		return ConsoleResult{Error: err.Error()}
	}
	if knowledge.Directory != "" {
		defer func() { _ = os.RemoveAll(knowledge.Directory) }()
	}
	runID := fmt.Sprintf("%d", time.Now().UnixNano())
	record := func(event KnowledgeTraceEvent) {
		event.RunID = runID
		event.AgentID = request.AgentID
		event.At = time.Now().UTC().Format(time.RFC3339Nano)
		if h.ctx != nil {
			runtime.EventsEmit(h.ctx, "native-knowledge", event)
		}
		knowledge.Events = append(knowledge.Events, event)
	}
	initial := knowledge.Events
	knowledge.Events = nil
	for _, event := range initial {
		if event.Kind == "knowledge.injected" {
			event.Kind = "knowledge.selected"
		}
		record(event)
	}

	var contextText strings.Builder
	fmt.Fprintf(&contextText, "Knowledge pack: %s; version: %s; pack status: %s; source revision: %s\n", knowledge.PackID, knowledge.Version, knowledge.Status, knowledge.Revision)
	contextText.WriteString("Role: " + request.Role + "\n")
	contextText.WriteString("Document status 'draft' means provisional guidance, not owner-approved or runtime authorization.\n")
	contextText.WriteString("The following bootstrap context applies to this execution:\n")
	contextText.WriteString(knowledge.Bootstrap)
	if knowledge.Directory != "" {
		contextText.WriteString("\nOn-demand directory: " + knowledge.Directory + "\n")
		contextText.WriteString("Available document IDs, titles, kinds, descriptions and paths:\n" + knowledge.Index)
		contextText.WriteString("Read these local files only when relevant; their contents were not injected into the prompt.\n")
	}
	contextText.WriteString("\n--- User request ---\n" + prompt)

	if knowledge.Directory == "" {
		knowledge.Directory, err = os.MkdirTemp("", "ae-knowledge-run-*")
		if err != nil {
			return ConsoleResult{Error: err.Error()}
		}
		defer func() { _ = os.RemoveAll(knowledge.Directory) }()
	}
	started := func() {
		for _, event := range initial {
			if event.Kind == "knowledge.injected" {
				record(event)
			}
		}
		record(KnowledgeTraceEvent{Kind: "execution.started"})
	}
	result := h.runPrompt(name, path, request.RepositoryDir, contextText.String(), "", model, knowledge.Directory, started)
	result.RunID = runID
	result.EstimatedContextTokens = int64((contextText.Len() + 3) / 4)
	if result.Usage != nil {
		record(KnowledgeTraceEvent{
			Kind:             "usage.reported",
			InputTokens:      result.Usage.InputTokens,
			OutputTokens:     result.Usage.OutputTokens,
			CacheReadTokens:  result.Usage.CacheReadTokens,
			CacheWriteTokens: result.Usage.CacheWriteTokens,
		})
	}
	outcome := "execution.completed"
	if result.Error != "" {
		outcome = "execution.failed"
	}
	record(KnowledgeTraceEvent{Kind: outcome})
	result.KnowledgeEvents = knowledge.Events
	return result
}
