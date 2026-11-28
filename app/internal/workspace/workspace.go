// Package workspace prepares isolated Git worktrees for issue participants and
// captures what actually changed in them.
//
// Participants can write anything inside their worktree, including its .git
// file, .gitattributes and hook directories. Every Git command issued here
// therefore names the repository metadata recorded at creation and disables
// hooks, so worktree content never makes the application run a program.
package workspace

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/anvh2/agentic-engineering/app/internal/agent"
)

const (
	// MaxPatchBytes bounds one repository's captured patch.
	MaxPatchBytes = 8 << 20

	maxStderrBytes = 4 << 10
	commandTimeout = 2 * time.Minute
)

var (
	// ErrNotRepository means the path is not the root of a Git checkout.
	ErrNotRepository = errors.New("path is not the root of a Git checkout")
	// ErrPatchTooLarge means a change set exceeds MaxPatchBytes.
	ErrPatchTooLarge = errors.New("change set exceeds the 8 MiB evidence limit")
)

// Repository is one repository linked to a project.
type Repository struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
}

// Checkout is a worktree this application created.
type Checkout struct {
	Repository Repository
	Base       string // commit the worktree started from
	Dir        string
	GitDir     string // the worktree's metadata directory, recorded at creation
}

// File is one changed file. Added and Deleted are -1 for binary files.
type File struct {
	Path    string `json:"path"`
	Status  string `json:"status"`
	Added   int    `json:"added"`
	Deleted int    `json:"deleted"`
}

// Snapshot is the complete content of a worktree relative to its base,
// including new files and any commits the participant made.
type Snapshot struct {
	Commit      string // a commit on Base holding the content; referenced by no branch
	Tree        string
	Files       []File
	Patch       string
	PatchSHA256 string
}

// Changed reports whether the worktree differs from its base.
func (s Snapshot) Changed() bool { return len(s.Files) > 0 }

// Resolve returns the canonical root of the repository at path. A leading "~/"
// is expanded.
func Resolve(ctx context.Context, path string) (string, error) {
	path = strings.TrimSpace(path)
	if rest, ok := strings.CutPrefix(path, "~/"); ok {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve home directory: %w", err)
		}
		path = filepath.Join(home, rest)
	}
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("%w: %q is not an absolute path", ErrNotRepository, path)
	}
	absolute, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", fmt.Errorf("%w: %s does not exist", ErrNotRepository, path)
	}
	output, err := run(ctx, nil, "-C", absolute, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", fmt.Errorf("%w: %s: %w", ErrNotRepository, path, err)
	}
	root, err := filepath.EvalSymlinks(strings.TrimSpace(output))
	if err != nil {
		return "", fmt.Errorf("%w: %s: %w", ErrNotRepository, path, err)
	}
	if root != absolute {
		return "", fmt.Errorf("%w: select the repository root instead of %s", ErrNotRepository, path)
	}
	return absolute, nil
}

// Create adds a detached worktree of the repository's current HEAD under its
// .worktrees directory. repository.Path must come from Resolve.
func Create(ctx context.Context, repository Repository, label string) (Checkout, error) {
	checkout := Checkout{Repository: repository}
	head, err := run(ctx, nil, "-C", repository.Path, "rev-parse", "--verify", "HEAD^{commit}")
	if err != nil {
		return checkout, fmt.Errorf("repository %s has no commit to start from: %w", repository.Name, err)
	}
	checkout.Base = strings.TrimSpace(head)
	parent := filepath.Join(repository.Path, ".worktrees")
	if err := os.MkdirAll(parent, 0700); err != nil {
		return checkout, fmt.Errorf("create worktree directory: %w", err)
	}
	// Reserve a unique name; git creates the directory itself.
	dir, err := os.MkdirTemp(parent, label+"-*")
	if err != nil {
		return checkout, fmt.Errorf("reserve worktree name: %w", err)
	}
	if err := os.Remove(dir); err != nil {
		return checkout, fmt.Errorf("reserve worktree name: %w", err)
	}
	if _, err := run(ctx, nil, "-C", repository.Path, "worktree", "add", "--detach", dir, checkout.Base); err != nil {
		return checkout, fmt.Errorf("create isolated worktree of %s: %w", repository.Name, err)
	}
	checkout.Dir = dir
	gitDir, err := run(ctx, nil, "-C", dir, "rev-parse", "--absolute-git-dir")
	if err != nil {
		return checkout, fmt.Errorf("locate worktree metadata: %w", err)
	}
	checkout.GitDir = strings.TrimSpace(gitDir)
	return checkout, nil
}

// Discard removes a worktree that holds no work. Git refuses when it has
// changes, and that refusal is returned so the files stay for inspection.
func Discard(ctx context.Context, checkout Checkout) error {
	_, err := run(ctx, nil, "-C", checkout.Repository.Path, "worktree", "remove", checkout.Dir)
	return err
}

func (c Checkout) git(ctx context.Context, env map[string]string, args ...string) (string, error) {
	return run(ctx, env, append([]string{"--git-dir=" + c.GitDir, "--work-tree=" + c.Dir}, args...)...)
}

// Tree stores the worktree's current content and returns its tree id. It uses a
// private index, so the participant's index state (including assume-unchanged
// flags) cannot hide a change.
func (c Checkout) Tree(ctx context.Context) (string, error) {
	directory, err := os.MkdirTemp("", "ae-index-*")
	if err != nil {
		return "", fmt.Errorf("create snapshot index: %w", err)
	}
	defer func() { _ = os.RemoveAll(directory) }() // Best effort: a stray temp index is harmless.
	env := map[string]string{"GIT_INDEX_FILE": filepath.Join(directory, "index")}
	if _, err := c.git(ctx, env, "read-tree", c.Base); err != nil {
		return "", fmt.Errorf("read base tree: %w", err)
	}
	// The native harness's own bookkeeping is never part of a change set.
	if _, err := c.git(ctx, env, "-C", c.Dir, "add", "--all", "--", ".",
		":(exclude,glob)**/.claude/.cc-writes/**", ":(exclude,glob)**/.claude/settings.local.json"); err != nil {
		return "", fmt.Errorf("index worktree: %w", err)
	}
	tree, err := c.git(ctx, env, "write-tree")
	if err != nil {
		return "", fmt.Errorf("write worktree tree: %w", err)
	}
	return strings.TrimSpace(tree), nil
}

// Capture records the worktree's content as a commit and its patch.
func (c Checkout) Capture(ctx context.Context, message string) (Snapshot, error) {
	var snapshot Snapshot
	tree, err := c.Tree(ctx)
	if err != nil {
		return snapshot, err
	}
	snapshot.Tree = tree
	identity := map[string]string{
		"GIT_AUTHOR_NAME": "Agentic Engineering", "GIT_AUTHOR_EMAIL": "runtime@localhost",
		"GIT_COMMITTER_NAME": "Agentic Engineering", "GIT_COMMITTER_EMAIL": "runtime@localhost",
	}
	commit, err := c.git(ctx, identity, "commit-tree", "--no-gpg-sign", tree, "-p", c.Base, "-m", message)
	if err != nil {
		return snapshot, fmt.Errorf("record snapshot commit: %w", err)
	}
	snapshot.Commit = strings.TrimSpace(commit)
	diff := []string{"diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--ignore-submodules=all"}
	diffArgs := func(extra ...string) []string {
		args := append(append([]string{}, diff...), extra...)
		return append(args, c.Base, snapshot.Commit, "--")
	}
	status, err := c.git(ctx, nil, diffArgs("--name-status", "-z")...)
	if err != nil {
		return snapshot, fmt.Errorf("list changed files: %w", err)
	}
	counts, err := c.git(ctx, nil, diffArgs("--numstat", "-z")...)
	if err != nil {
		return snapshot, fmt.Errorf("count changed lines: %w", err)
	}
	snapshot.Files = parseFiles(status, counts)
	snapshot.Patch, err = c.git(ctx, nil, diffArgs("--binary")...)
	if err != nil {
		return snapshot, fmt.Errorf("capture patch: %w", err)
	}
	sum := sha256.Sum256([]byte(snapshot.Patch))
	snapshot.PatchSHA256 = hex.EncodeToString(sum[:])
	return snapshot, nil
}

// Show makes the worktree match commit, dropping any other tracked or untracked
// content. Use it only on a reviewer's worktree, which holds no deliverable.
func (c Checkout) Show(ctx context.Context, commit string) error {
	if _, err := c.git(ctx, nil, "-C", c.Dir, "checkout", "--force", "--detach", commit); err != nil {
		return fmt.Errorf("check out snapshot: %w", err)
	}
	// git clean resolves paths against the current directory.
	if _, err := c.git(ctx, nil, "-C", c.Dir, "clean", "-fdq"); err != nil {
		return fmt.Errorf("clean review worktree: %w", err)
	}
	return nil
}

func parseFiles(status, counts string) []File {
	type lines struct{ added, deleted int }
	byPath := map[string]lines{}
	for _, record := range strings.Split(counts, "\x00") {
		fields := strings.SplitN(record, "\t", 3)
		if len(fields) != 3 {
			continue
		}
		byPath[fields[2]] = lines{lineCount(fields[0]), lineCount(fields[1])}
	}
	files := []File{}
	fields := strings.Split(status, "\x00")
	for i := 0; i+1 < len(fields); i += 2 {
		path := fields[i+1]
		files = append(files, File{Path: path, Status: fields[i], Added: byPath[path].added, Deleted: byPath[path].deleted})
	}
	return files
}

func lineCount(field string) int {
	n, err := strconv.Atoi(field)
	if err != nil {
		return -1 // Git prints "-" for binary content.
	}
	return n
}

type cappedBuffer struct {
	bytes.Buffer
	limit    int
	overflow bool
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > b.limit {
		b.overflow = true
		return 0, ErrPatchTooLarge
	}
	return b.Buffer.Write(p)
}

func run(ctx context.Context, env map[string]string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	safe := []string{"--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"}
	cmd := exec.CommandContext(ctx, "git", append(safe, args...)...)
	extra := map[string]string{"GIT_TERMINAL_PROMPT": "0"}
	for key, value := range env {
		extra[key] = value
	}
	cmd.Env = agent.CleanEnv(extra)
	stdout := &cappedBuffer{limit: MaxPatchBytes}
	stderr := &cappedBuffer{limit: maxStderrBytes}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	err := cmd.Run()
	if stdout.overflow {
		return "", ErrPatchTooLarge
	}
	if err != nil {
		return "", fmt.Errorf("git: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}
