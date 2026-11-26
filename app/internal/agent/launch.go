package agent

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// inheritedEnv is the allowlist copied from the application's environment.
// Everything else is dropped: a child launched from an IDE or another agent
// would otherwise inherit that harness's session identity and messaging
// credentials (evidence E10). Native login lives in the keychain and in the
// CLIs' own home directories, so it needs none of them (evidence E8).
var inheritedEnv = map[string]bool{
	"HOME": true, "USER": true, "LOGNAME": true, "SHELL": true, "TMPDIR": true,
	"TERM": true, "TZ": true, "LANG": true, "SSH_AUTH_SOCK": true,
}

// CleanEnv builds a child environment: allowlisted inherited variables, a
// resolved PATH, then explicit additions (from the user's settings and the
// launcher, e.g. TokenEnv), which win.
func CleanEnv(extra map[string]string) []string {
	env := map[string]string{}
	for _, kv := range os.Environ() {
		k, v, ok := strings.Cut(kv, "=")
		if ok && (inheritedEnv[k] || strings.HasPrefix(k, "LC_")) {
			env[k] = v
		}
	}
	env["PATH"] = ResolvedPATH()
	for k, v := range extra {
		env[k] = v
	}
	out := make([]string, 0, len(env))
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	return out
}

// ResolvedPATH is the inherited PATH followed by the standard locations
// command-line tools live in on macOS. A GUI app starts with launchd's
// /usr/bin:/bin:/usr/sbin:/sbin, where Homebrew tools (git, go, node) and the
// native CLIs are missing.
func ResolvedPATH() string {
	home, _ := os.UserHomeDir()
	candidates := append(filepath.SplitList(os.Getenv("PATH")),
		"/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin",
		filepath.Join(home, ".local", "bin"), filepath.Join(home, "go", "bin"),
		"/usr/bin", "/bin", "/usr/sbin", "/sbin")
	seen := map[string]bool{}
	var out []string
	for _, d := range candidates {
		if d == "" || seen[d] || !filepath.IsAbs(d) {
			continue
		}
		seen[d] = true
		out = append(out, d)
	}
	return strings.Join(out, string(os.PathListSeparator))
}

// ProcessSpec describes one native process.
type ProcessSpec struct {
	Path  string
	Args  []string
	Env   []string
	Dir   string
	Stdin []byte // the prompt; keeps task text out of argv, which other local processes can read
	// OnLine receives each stdout line in order, without the newline. The
	// slice is only valid during the call.
	OnLine func(line []byte)
	// Grace is how long an interrupted process may take to exit after SIGINT
	// before the whole process group is killed. Zero means DefaultGrace.
	Grace time.Duration
}

// ProcessResult is what happened to the process.
type ProcessResult struct {
	ExitCode    int
	Interrupted bool   // ctx was cancelled before the process exited
	StderrTail  string // last StderrTailBytes of stderr, for diagnosis only; may contain anything the CLI printed
}

const (
	DefaultGrace    = 10 * time.Second
	MaxLineBytes    = 32 << 20
	StderrTailBytes = 16 << 10
)

// ErrLineTooLong means a native event exceeded MaxLineBytes; the stream is
// unusable from that point.
var ErrLineTooLong = errors.New("native event exceeds maximum line size")

// RunProcess runs a native CLI in its own process group and streams stdout
// lines. Cancelling ctx sends SIGINT to the group (the CLIs' own graceful
// interrupt), then SIGKILL after the grace period. Only the group this call
// created is ever signalled.
func RunProcess(ctx context.Context, spec ProcessSpec) (ProcessResult, error) {
	if !filepath.IsAbs(spec.Path) {
		return ProcessResult{}, errors.New("native binary path must be absolute")
	}
	cmd := exec.Command(spec.Path, spec.Args...)
	cmd.Env = spec.Env
	cmd.Dir = spec.Dir
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if spec.Stdin != nil {
		cmd.Stdin = strings.NewReader(string(spec.Stdin))
	} // nil Stdin is /dev/null: the CLIs otherwise wait for piped input
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return ProcessResult{}, err
	}
	tail := &tailBuffer{max: StderrTailBytes}
	cmd.Stderr = tail
	if err := cmd.Start(); err != nil {
		return ProcessResult{}, err
	}
	pgid := cmd.Process.Pid

	grace := spec.Grace
	if grace <= 0 {
		grace = DefaultGrace
	}
	exited := make(chan struct{})
	var interrupted bool
	var mu sync.Mutex
	go func() {
		select {
		case <-exited:
			return
		case <-ctx.Done():
		}
		mu.Lock()
		interrupted = true
		mu.Unlock()
		_ = syscall.Kill(-pgid, syscall.SIGINT)
		select {
		case <-exited:
		case <-time.After(grace):
			_ = syscall.Kill(-pgid, syscall.SIGKILL)
		}
	}()

	readErr := readLines(stdout, spec.OnLine)
	if readErr != nil {
		// Stop the producer; we can no longer consume its stream.
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		io.Copy(io.Discard, stdout)
	}
	waitErr := cmd.Wait()
	close(exited)

	res := ProcessResult{ExitCode: cmd.ProcessState.ExitCode(), StderrTail: tail.String()}
	mu.Lock()
	res.Interrupted = interrupted
	mu.Unlock()
	if readErr != nil {
		return res, readErr
	}
	var exitErr *exec.ExitError
	if waitErr != nil && !errors.As(waitErr, &exitErr) {
		return res, waitErr
	}
	return res, nil
}

func readLines(r io.Reader, onLine func([]byte)) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), MaxLineBytes)
	for sc.Scan() {
		if onLine != nil {
			onLine(sc.Bytes())
		}
	}
	if errors.Is(sc.Err(), bufio.ErrTooLong) {
		return ErrLineTooLong
	}
	return sc.Err()
}

// tailBuffer keeps the last max bytes written to it.
type tailBuffer struct {
	mu  sync.Mutex
	max int
	buf []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if over := len(t.buf) - t.max; over > 0 {
		t.buf = append(t.buf[:0], t.buf[over:]...)
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}
