package main

import (
 "context"
 "fmt"
 "os"
 "os/exec"
 "time"
 "strings"

 "github.com/coder/acp-go-sdk"
)

// Embed the SDK interface for this initialize-only probe. No session is created;
// any unexpected client callback fails closed at the process boundary.
type probeClient struct { acp.Client }

func (p *probeClient) RequestPermission(_ context.Context, _ acp.RequestPermissionRequest) (acp.RequestPermissionResponse, error) {
 return acp.RequestPermissionResponse{}, fmt.Errorf("permissions unavailable in initialize-only probe")
}

func (p *probeClient) SessionUpdate(_ context.Context, n acp.SessionNotification) error {
 if u := n.Update.AgentMessageChunk; u != nil && u.Content.Text != nil { fmt.Print(u.Content.Text.Text) }
 return nil
}

func run(ctx context.Context, executable string, prompt bool) error {
 dir, err := os.MkdirTemp("", "ae-acp-probe-*")
 if err != nil { return err }
 defer os.RemoveAll(dir)
 cmd := exec.CommandContext(ctx, executable)
 cmd.Stderr = os.Stderr
 cmd.Dir = dir
 cmd.Env = append(os.Environ(), "INITIAL_AGENT_MODE=read-only")
 stdin, err := cmd.StdinPipe()
 if err != nil { return err }
 stdout, err := cmd.StdoutPipe()
 if err != nil { return err }
 if err := cmd.Start(); err != nil { return err }
 defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
 conn := acp.NewClientSideConnection(&probeClient{}, stdin, stdout)
 response, err := conn.Initialize(ctx, acp.InitializeRequest{ProtocolVersion: acp.ProtocolVersionNumber})
 if err != nil { return fmt.Errorf("ACP initialize: %w", err) }
 if response.ProtocolVersion != acp.ProtocolVersionNumber { return fmt.Errorf("unsupported negotiated protocol: %v", response.ProtocolVersion) }
 fmt.Println("ACP initialize succeeded; protocol", response.ProtocolVersion)
 if !prompt { return nil }
 session, err := conn.NewSession(ctx, acp.NewSessionRequest{Cwd: dir, McpServers: []acp.McpServer{}})
 if err != nil { return fmt.Errorf("new session: %w", err) }
 result, err := conn.Prompt(ctx, acp.PromptRequest{SessionId: session.SessionId, Prompt: []acp.ContentBlock{acp.TextBlock("Reply with ACP_OK only. Do not use tools or modify files.")}})
 if err != nil { return fmt.Errorf("prompt: %w", err) }
 fmt.Printf("\nStop reason: %v\n", result.StopReason)
 return nil
}

func main() {
 if (len(os.Args) != 2 && len(os.Args) != 3) || (os.Args[1] != "claude-agent-acp" && os.Args[1] != "codex-acp") {
  fmt.Fprintln(os.Stderr, "usage: acp-spike claude-agent-acp|codex-acp")
  os.Exit(2)
 }
 prompt := len(os.Args) == 3 && strings.EqualFold(os.Args[2], "--prompt")
 if len(os.Args) == 3 && !prompt { os.Exit(2) }
 ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
 defer cancel()
 if err := run(ctx, os.Args[1], prompt); err != nil {
  fmt.Fprintln(os.Stderr, err)
  os.Exit(1)
 }
}
