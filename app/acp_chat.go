package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"

	"github.com/coder/acp-go-sdk"
)

// ACP callbacks are deliberately restricted until scoped filesystem and
// interactive permission support are implemented.
type desktopACPClient struct {
	acp.Client
	mu sync.Mutex
	stream *chatStream
}

func (c *desktopACPClient) RequestPermission(_ context.Context, _ acp.RequestPermissionRequest) (acp.RequestPermissionResponse, error) {
	return acp.RequestPermissionResponse{}, fmt.Errorf("permission requires explicit approval; unavailable in ACP preview")
}

func (c *desktopACPClient) SessionUpdate(_ context.Context, n acp.SessionNotification) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	u := n.Update
	switch {
	case u.AgentMessageChunk != nil:
		if t := u.AgentMessageChunk.Content.Text; t != nil {
			c.stream.text(t.Text)
		}
	case u.ToolCall != nil:
		c.stream.tool(string(u.ToolCall.ToolCallId), fmt.Sprint(u.ToolCall.Title), fmt.Sprint(u.ToolCall.Status), "")
	case u.ToolCallUpdate != nil:
		status := ""
		if u.ToolCallUpdate.Status != nil {
			status = fmt.Sprint(*u.ToolCallUpdate.Status)
		}
		c.stream.tool(string(u.ToolCallUpdate.ToolCallId), "", status, "")
	}
	return nil
}

func runACPChat(ctx context.Context, name, nativePath, dir, prompt string, stream *chatStream, onStart func()) ConsoleResult {
	binary := "claude-agent-acp"
	if name == "Codex" {
		binary = "codex-acp"
	}
	// Use the same desktop PATH as native discovery; never download at runtime.
	path := filepath.Dir(nativePath)+":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:"+os.Getenv("PATH")
	var executable string
	for _, base := range filepath.SplitList(path) {
		candidate := filepath.Join(base, binary)
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0 {
			executable = candidate
			break
		}
	}
	if executable == "" {
		return ConsoleResult{Error: "ACP adapter not installed: "+binary}
	}
	cmd := exec.CommandContext(ctx, executable)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "PATH="+path, "INITIAL_AGENT_MODE=read-only")
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil { return ConsoleResult{Error: err.Error()} }
	stdout, err := cmd.StdoutPipe()
	if err != nil { return ConsoleResult{Error: err.Error()} }
	if err := cmd.Start(); err != nil { return ConsoleResult{Error: err.Error()} }
	defer func(){ _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	client := &desktopACPClient{stream:stream}
	conn := acp.NewClientSideConnection(client, stdin, stdout)
	init, err := conn.Initialize(ctx, acp.InitializeRequest{ProtocolVersion:acp.ProtocolVersionNumber})
	if err != nil { return ConsoleResult{Error:fmt.Sprintf("ACP initialize: %v",err)} }
	if init.ProtocolVersion != acp.ProtocolVersionNumber { return ConsoleResult{Error:"Unsupported ACP protocol"} }
	session, err := conn.NewSession(ctx, acp.NewSessionRequest{Cwd:dir, McpServers:[]acp.McpServer{}})
	if err != nil { return ConsoleResult{Error:fmt.Sprintf("ACP session: %v",err)} }
	if onStart != nil { onStart() }
	_, err = conn.Prompt(ctx, acp.PromptRequest{SessionId:session.SessionId, Prompt:[]acp.ContentBlock{acp.TextBlock(prompt)}})
	client.mu.Lock()
	defer client.mu.Unlock()
	result := ConsoleResult{Output:stream.answer.String()}
	if err != nil { result.Error = fmt.Sprintf("ACP prompt: %v",err) }
	return result
}
