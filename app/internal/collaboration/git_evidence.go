package collaboration

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
	"strings"
	"time"

	"github.com/anvh2/agentic-engineering/app/internal/agent"
)

const (
	maxGitEvidenceBytes = 8 << 20
	gitEvidenceDeadline = 10 * time.Second
)

type gitEvidence struct {
	Head string
	Status string
	DiffPath string
	DiffSHA256 string
}

type cappedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > b.limit {
		return 0, errors.New("git evidence exceeds 8 MiB limit")
	}
	return b.Buffer.Write(p)
}

func runGitEvidence(ctx context.Context, workdir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", workdir, "--no-pager"}, args...)...)
	cmd.Env = agent.CleanEnv(nil)
	var output cappedBuffer
	output.limit = maxGitEvidenceBytes
	cmd.Stdout = &output
	var stderr cappedBuffer
	stderr.limit = 4 << 10
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git evidence: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return output.String(), nil
}

// Capture an immutable, bounded snapshot of the participant's tracked patch
// and full status. Untracked paths appear in status, but their contents are
// not automatically exposed to models or pushed to remote repositories.
func captureGitEvidence(ctx context.Context, workdir, evidenceDir, turnID string) (gitEvidence, error) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), gitEvidenceDeadline)
	defer cancel()
	var evidence gitEvidence
	head, err := runGitEvidence(ctx, workdir, "rev-parse", "HEAD")
	if err != nil {
		return evidence, err
	}
	status, err := runGitEvidence(ctx, workdir, "status", "--porcelain=v1", "--untracked-files=normal")
	if err != nil {
		return evidence, err
	}
	diff, err := runGitEvidence(ctx, workdir, "diff", "--no-ext-diff", "--binary", "HEAD", "--")
	if err != nil {
		return evidence, err
	}
	evidence.Head = strings.TrimSpace(head)
	evidence.Status = status
	evidence.DiffPath = filepath.Join(evidenceDir, turnID+".patch")
	data := []byte(diff)
	sum := sha256.Sum256(data)
	if err := os.WriteFile(evidence.DiffPath, data, 0600); err != nil {
		return evidence, fmt.Errorf("write git patch evidence: %w", err)
	}
	evidence.DiffSHA256 = hex.EncodeToString(sum[:])
	return evidence, nil
}
