package main

import (
 "context"
 "fmt"
 "os"
 "os/exec"
 "time"

 "github.com/coder/acp-go-sdk"
)

// Embed the SDK interface for this initialize-only probe. No session is created;
// any unexpected client callback fails closed at the process boundary.
type probeClient struct { acp.Client }

func (p *probeClient) RequestPermission(_ context.Context, _ acp.RequestPermissionRequest) (acp.RequestPermissionResponse, error) {
 return acp.RequestPermissionResponse{}, fmt.Errorf("permissions unavailable in initialize-only probe")
}

func (p *probeClient) SessionUpdate(_ context.Context, _ acp.SessionNotification) error {
 return fmt.Errorf("unexpected session update in initialize-only probe")
}

func run(ctx context.Context, executable string) error {
 cmd := exec.CommandContext(ctx, executable)
 cmd.Stderr = os.Stderr
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
 return nil
}

func main() {
 if len(os.Args) != 2 || (os.Args[1] != "claude-agent-acp" && os.Args[1] != "codex-acp") {
  fmt.Fprintln(os.Stderr, "usage: acp-spike claude-agent-acp|codex-acp")
  os.Exit(2)
 }
 ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
 defer cancel()
 if err := run(ctx, os.Args[1]); err != nil {
  fmt.Fprintln(os.Stderr, err)
  os.Exit(1)
 }
}
