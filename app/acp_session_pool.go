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

	"github.com/coder/acp-go-sdk"
)

const defaultACPIdleTimeout = 10 * time.Minute

// ACP sessions are process-local. Each conversation keeps its adapter process,
// connection, and ACP session alive between prompts, bounded by an idle TTL.
type acpSessionPool struct {
	mu          sync.Mutex
	sessions    map[string]*acpChatSession
	idleTimeout time.Duration
	starting map[string]bool
	closed bool
	pending sync.WaitGroup // every in-flight startup is joined on shutdown
}

type acpChatSession struct {
	cmd      *exec.Cmd
	conn     *acp.ClientSideConnection
	client   *desktopACPClient
	id       acp.SessionId
	busy     bool
	timer    *time.Timer
	shutdown func()
	once     sync.Once
}

func (s *acpChatSession) close() {
	s.once.Do(func() {
		if s.shutdown != nil {
			s.shutdown()
		}
	})
}

func acpIdleTimeout() time.Duration {
	if raw := os.Getenv("AE_ACP_IDLE_TIMEOUT"); raw != "" {
		if value, err := time.ParseDuration(raw); err == nil && value >= time.Second && value <= 24*time.Hour {
			return value
		}
	}
	return defaultACPIdleTimeout
}

func (p *acpSessionPool) idle() time.Duration {
	if p.idleTimeout > 0 {
		return p.idleTimeout
	}
	return acpIdleTimeout()
}

func acpPoolKey(name, adapterPath, directory, conversationKey string) string {
	if conversationKey == "" {
		return ""
	}
	return strings.Join([]string{name, adapterPath, filepath.Clean(directory), conversationKey}, "\x00")
}

func findACPAdapter(name, nativePath string) (string, string, error) {
	binary := "claude-agent-acp"
	if name == "Codex" {
		binary = "codex-acp"
	}
	searchPath := filepath.Dir(nativePath) + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + os.Getenv("PATH")
	for _, base := range filepath.SplitList(searchPath) {
		candidate := filepath.Join(base, binary)
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0 {
			return candidate, searchPath, nil
		}
	}
	return "", "", fmt.Errorf("ACP adapter not installed: %s", binary)
}

func startACPSession(ctx context.Context, name, nativePath, directory string) (_ *acpChatSession, err error) {
	executable, searchPath, err := findACPAdapter(name, nativePath)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(executable)
	cmd.Dir = directory
	cmd.Env = append(os.Environ(), "PATH="+searchPath, "INITIAL_AGENT_MODE=read-only")
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return nil, err
	}
	session := &acpChatSession{cmd: cmd, client: &desktopACPClient{}}
	session.shutdown = func() {
		_ = stdin.Close()
		_ = stdout.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}
	defer func() {
		if err != nil {
			session.close()
		}
	}()
	session.conn = acp.NewClientSideConnection(session.client, stdin, stdout)
	init, err := session.conn.Initialize(ctx, acp.InitializeRequest{ProtocolVersion: acp.ProtocolVersionNumber})
	if err != nil {
		return nil, fmt.Errorf("ACP initialize: %w", err)
	}
	if init.ProtocolVersion != acp.ProtocolVersionNumber {
		return nil, errors.New("unsupported ACP protocol")
	}
	created, err := session.conn.NewSession(ctx, acp.NewSessionRequest{Cwd: directory, McpServers: []acp.McpServer{}})
	if err != nil {
		return nil, fmt.Errorf("ACP new session: %w", err)
	}
	session.id = created.SessionId
	return session, nil
}

func (p *acpSessionPool) acquire(ctx context.Context, key, name, nativePath, directory string) (*acpChatSession, bool, error) {
	var stale *acpChatSession
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil, false, errors.New("ACP pool closed")
	}
	if key != "" {
		if p.starting[key] {
			p.mu.Unlock()
			return nil, false, errors.New("ACP conversation already starting")
		}
		if current := p.sessions[key]; current != nil {
			select {
			case <-current.conn.Done():
				delete(p.sessions, key)
				stale = current
			default:
				if current.busy {
					p.mu.Unlock()
					return nil, false, errors.New("ACP conversation already running")
				}
				if current.timer != nil {
					current.timer.Stop()
					current.timer = nil
				}
				current.busy = true
				p.mu.Unlock()
				return current, true, nil
			}
		}
		if p.starting == nil {
			p.starting = make(map[string]bool)
		}
		p.starting[key] = true
	}
	p.pending.Add(1)
	p.mu.Unlock()
	if stale != nil {
		stale.close()
	}
	session, err := startACPSession(ctx, name, nativePath, directory)
	p.mu.Lock()
	defer p.pending.Done()
	delete(p.starting, key)
	if err != nil {
		p.mu.Unlock()
		return nil, false, err
	}
	if p.closed {
		p.mu.Unlock()
		session.close()
		return nil, false, errors.New("ACP pool closed")
	}
	session.busy = true
	if key != "" {
		if p.sessions == nil {
			p.sessions = make(map[string]*acpChatSession)
		}
		p.sessions[key] = session
	}
	p.mu.Unlock()
	return session, false, nil
}

func (p *acpSessionPool) release(key string, session *acpChatSession, healthy bool) {
	if key == "" {
		session.close()
		return
	}
	p.mu.Lock()
	if p.sessions[key] != session {
		p.mu.Unlock()
		session.close()
		return
	}
	if !healthy {
		delete(p.sessions, key)
		p.mu.Unlock()
		session.close()
		return
	}
	session.busy = false
	session.timer = time.AfterFunc(p.idle(), func() {
		p.mu.Lock()
		if p.sessions[key] != session || session.busy {
			p.mu.Unlock()
			return
		}
		delete(p.sessions, key)
		p.mu.Unlock()
		session.close()
	})
	p.mu.Unlock()
}

func (p *acpSessionPool) closeAll() {
	p.mu.Lock()
	p.closed = true
	sessions := p.sessions
	p.sessions = nil
	for _, session := range sessions {
		if session.timer != nil {
			session.timer.Stop()
		}
	}
	p.mu.Unlock()
	for _, session := range sessions {
		session.close()
	}
	// Startup goroutines have observed the closed flag and terminated their
	// newly spawned adapters before the pool can finish shutting down.
	p.pending.Wait()
}

func (p *acpSessionPool) run(ctx context.Context, name, nativePath, directory, prompt, conversationKey, followUp string, stream *chatStream, onStart func(bool)) ConsoleResult {
	key := acpPoolKey(name, nativePath, directory, conversationKey)
	stream.activity("Connecting to " + name + " ACP…")
	session, reused, err := p.acquire(ctx, key, name, nativePath, directory)
	if err != nil {
		return ConsoleResult{Error: err.Error()}
	}
	healthy := false
	defer func() { p.release(key, session, healthy) }()
	session.client.setStream(stream)
	defer session.client.setStream(nil)
	if reused {
		stream.activity("ACP session reused")
		if followUp != "" {
			prompt = followUp
		}
	} else {
		stream.activity("ACP session created")
	}
	if onStart != nil {
		onStart(reused)
	}
	// Provider commands must be advertised and sent verbatim, without bootstrap.
	if strings.HasPrefix(followUp, "/") {
		command := strings.TrimPrefix(strings.Fields(followUp)[0], "/")
		session.client.mu.Lock()
		supported := false
		for _, candidate := range session.client.commands {
			if candidate.Name == command {
				supported = true
				break
			}
		}
		session.client.mu.Unlock()
		if !reused || !supported {
			healthy = reused
			return ConsoleResult{Error: "Command unavailable in current ACP session"}
		}
		prompt = followUp
	}
	response, err := session.conn.Prompt(ctx, acp.PromptRequest{
		SessionId: session.id,
		Prompt:    []acp.ContentBlock{acp.TextBlock(prompt)},
	})
	session.client.mu.Lock()
	output := stream.answer.String()
	commands := append([]acp.AvailableCommand{}, session.client.commands...)
	usage := session.client.usage
	session.client.mu.Unlock()
	result := ConsoleResult{Output: output, SessionID: string(session.id), SessionReused: reused, Commands: commands, ACPContext: usage}
	if err == nil {
		result.ACPUsage = response.Usage
	}
	if ctx.Err() != nil {
		result.Error = "ACP prompt cancelled or timed out"
	} else if err != nil {
		result.Error = fmt.Sprintf("ACP prompt: %v", err)
	} else {
		healthy = true
		if fmt.Sprint(response.StopReason) != "end_turn" {
			result.Error = fmt.Sprintf("ACP stopped: %v", response.StopReason)
		}
	}
	return result
}
