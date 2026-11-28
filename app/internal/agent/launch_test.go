package agent

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func run(t *testing.T, ctx context.Context, spec ProcessSpec) ([]string, ProcessResult, error) {
	t.Helper()
	var lines []string
	spec.OnLine = func(b []byte) { lines = append(lines, string(b)) }
	if spec.Env == nil {
		spec.Env = CleanEnv(nil)
	}
	res, err := RunProcess(ctx, spec)
	return lines, res, err
}

func TestCleanEnvDropsHarnessIdentityAndKeepsBasics(t *testing.T) {
	t.Setenv("CLAUDE_CODE_SESSION_ID", "parent-session")
	t.Setenv("CLAUDE_CODE_MESSAGING_TOKEN", "parent-secret")
	t.Setenv("CLAUDECODE", "1")
	t.Setenv("CODEX_THREAD_ID", "parent-thread")
	t.Setenv("VSCODE_PID", "1")
	t.Setenv("OPENAI_API_KEY", "sk-parent")
	t.Setenv("LC_ALL", "en_US.UTF-8")
	lines, _, err := run(t, context.Background(), ProcessSpec{Path: "/usr/bin/env", Env: CleanEnv(map[string]string{TokenEnv: "aet_child"})})
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(lines, "\n")
	for _, leaked := range []string{"CLAUDE_CODE_SESSION_ID", "parent-secret", "CLAUDECODE", "CODEX_THREAD_ID", "VSCODE_PID", "sk-parent"} {
		if strings.Contains(got, leaked) {
			t.Errorf("child environment leaked %s", leaked)
		}
	}
	for _, want := range []string{"HOME=", "PATH=", "LC_ALL=en_US.UTF-8", TokenEnv + "=aet_child"} {
		if !strings.Contains(got, want) {
			t.Errorf("child environment missing %s", want)
		}
	}
	if !strings.Contains(ResolvedPATH(), "/opt/homebrew/bin") || !strings.Contains(ResolvedPATH(), "/usr/bin") {
		t.Errorf("PATH lacks standard locations: %s", ResolvedPATH())
	}
}

func TestStdinPromptAndLines(t *testing.T) {
	lines, res, err := run(t, context.Background(), ProcessSpec{Path: "/bin/cat", Stdin: []byte("one\ntwo\n")})
	if err != nil || res.ExitCode != 0 || res.Interrupted || strings.Join(lines, ",") != "one,two" {
		t.Fatalf("lines=%v res=%+v err=%v", lines, res, err)
	}
}

func TestNonZeroExitIsAResultNotAnError(t *testing.T) {
	_, res, err := run(t, context.Background(), ProcessSpec{Path: "/bin/sh", Args: []string{"-c", "echo oops >&2; exit 7"}})
	if err != nil || res.ExitCode != 7 || !strings.Contains(res.StderrTail, "oops") {
		t.Fatalf("res=%+v err=%v", res, err)
	}
}

func TestRelativeBinaryRefused(t *testing.T) {
	if _, err := RunProcess(context.Background(), ProcessSpec{Path: "sh"}); err == nil {
		t.Fatal("relative path accepted")
	}
}

func TestCancelSendsSIGINTFirst(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	script := `trap 'echo interrupted; exit 3' INT; echo ready; while :; do sleep 0.05; done`
	var lines []string
	go func() { time.Sleep(300 * time.Millisecond); cancel() }()
	res, err := RunProcess(ctx, ProcessSpec{Path: "/bin/sh", Args: []string{"-c", script}, Env: CleanEnv(nil), Grace: 5 * time.Second,
		OnLine: func(b []byte) { lines = append(lines, string(b)) }})
	if err != nil || !res.Interrupted || res.ExitCode != 3 || strings.Join(lines, ",") != "ready,interrupted" {
		t.Fatalf("lines=%v res=%+v err=%v", lines, res, err)
	}
}

func TestCancelKillsGroupWhenSIGINTIgnored(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	// The grandchild ignores SIGINT too and would keep stdout open forever.
	script := `trap '' INT; sleep 30 & echo $!; wait`
	var grandchild int
	go func() { time.Sleep(300 * time.Millisecond); cancel() }()
	start := time.Now()
	res, err := RunProcess(ctx, ProcessSpec{Path: "/bin/sh", Args: []string{"-c", script}, Env: CleanEnv(nil), Grace: 200 * time.Millisecond,
		OnLine: func(b []byte) { grandchild, _ = strconv.Atoi(string(b)) }})
	if err != nil || !res.Interrupted {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatalf("kill escalation too slow: %v", time.Since(start))
	}
	if grandchild == 0 {
		t.Fatal("grandchild pid not reported")
	}
	if err := syscall.Kill(grandchild, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("grandchild %d survived the group kill: %v", grandchild, err)
	}
}

func TestOversizedLineIsAStreamError(t *testing.T) {
	_, _, err := run(t, context.Background(), ProcessSpec{Path: "/bin/sh", Args: []string{"-c", "head -c 34000000 /dev/zero | tr '\\0' a"}})
	if !errors.Is(err, ErrLineTooLong) {
		t.Fatalf("want ErrLineTooLong, got %v", err)
	}
}

func TestTailBufferKeepsTheEnd(t *testing.T) {
	b := &tailBuffer{max: 4}
	b.Write([]byte("abc"))
	b.Write([]byte("defg"))
	if b.String() != "defg" {
		t.Fatalf("got %q", b.String())
	}
}
