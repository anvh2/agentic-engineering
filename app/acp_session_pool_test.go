package main

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestACPPoolKeyIsolation(t *testing.T) {
	a := acpPoolKey("Claude", "/usr/local/bin/claude", "/repo", "project-a/agent-a")
	b := acpPoolKey("Claude", "/usr/local/bin/claude", "/repo", "project-b/agent-a")
	c := acpPoolKey("Codex", "/usr/local/bin/codex", "/repo", "project-a/agent-a")
	if a == b || a == c || strings.Contains(a, "/repo-other") {
		t.Fatalf("ACP conversation key not scoped correctly")
	}
	if acpPoolKey("Claude", "/bin/claude", "/repo", "") != "" {
		t.Fatal("one-shot execution must not be pooled")
	}
}

func TestACPPoolKeepsThenExpiresIdleSession(t *testing.T) {
	closed := make(chan struct{})
	session := &acpChatSession{busy: true, shutdown: func() { close(closed) }}
	p := &acpSessionPool{
		sessions:    map[string]*acpChatSession{"chat": session},
		idleTimeout: 30 * time.Millisecond,
	}
	p.release("chat", session, true)
	p.mu.Lock()
	kept := p.sessions["chat"] == session && !session.busy
	p.mu.Unlock()
	if !kept {
		t.Fatal("session should remain available after a successful turn")
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("idle ACP adapter was not closed")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.sessions["chat"] != nil {
		t.Fatal("expired ACP conversation remains pooled")
	}
}

func TestACPPoolFailureClosesSession(t *testing.T) {
	closed := make(chan struct{})
	session := &acpChatSession{busy: true, shutdown: func() { close(closed) }}
	p := &acpSessionPool{sessions: map[string]*acpChatSession{"chat": session}}
	p.release("chat", session, false)
	select {
	case <-closed:
	default:
		t.Fatal("failed or cancelled prompt must evict adapter")
	}
}

func TestACPPoolShutdownClosesBusySessions(t *testing.T) {
	closed := make(chan struct{})
	session := &acpChatSession{busy: true, shutdown: func() { close(closed) }}
	p := &acpSessionPool{sessions: map[string]*acpChatSession{"chat": session}}
	p.closeAll()
	p.closeAll()
	select {
	case <-closed:
	default:
		t.Fatal("shutdown must stop active adapter")
	}
}

func TestACPIdleTimeoutConfiguration(t *testing.T) {
	previous, had := os.LookupEnv("AE_ACP_IDLE_TIMEOUT")
	t.Cleanup(func() {
		if had {
			_ = os.Setenv("AE_ACP_IDLE_TIMEOUT", previous)
		} else {
			_ = os.Unsetenv("AE_ACP_IDLE_TIMEOUT")
		}
	})
	_ = os.Setenv("AE_ACP_IDLE_TIMEOUT", "45s")
	if acpIdleTimeout() != 45*time.Second {
		t.Fatal("custom ACP timeout not applied")
	}
	_ = os.Setenv("AE_ACP_IDLE_TIMEOUT", "invalid")
	if acpIdleTimeout() != defaultACPIdleTimeout {
		t.Fatal("invalid timeout should use default")
	}
}
