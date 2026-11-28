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
	stream.activity("Starting "+name+" ACP…")
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
	stream.activity("Creating ACP session…")
	session, err := conn.NewSession(ctx, acp.NewSessionRequest{Cwd:dir, McpServers:[]acp.McpServer{}})
	if err != nil { return ConsoleResult{Error:fmt.Sprintf("ACP session: %v",err)} }
	stream.activity("ACP session connected")
	if onStart != nil { onStart() }
	response, err := conn.Prompt(ctx, acp.PromptRequest{SessionId:session.SessionId, Prompt:[]acp.ContentBlock{acp.TextBlock(prompt)}})
	client.mu.Lock()
	defer client.mu.Unlock()
	result := ConsoleResult{Output:stream.answer.String()}
	if ctx.Err() != nil { result.Error = "ACP prompt cancelled or timed out" } else if err != nil { result.Error = fmt.Sprintf("ACP prompt: %v",err) } else if fmt.Sprint(response.StopReason) != "end_turn" { result.Error = fmt.Sprintf("ACP stopped: %v", response.StopReason) }
	return result
}

func (c *desktopACPClient) WriteTextFile(_ context.Context, _ acp.WriteTextFileRequest) (acp.WriteTextFileResponse, error) {
	return acp.WriteTextFileResponse{}, fmt.Errorf("ACP client capability not granted")
}

func (c *desktopACPClient) ReadTextFile(_ context.Context, _ acp.ReadTextFileRequest) (acp.ReadTextFileResponse, error) {
	return acp.ReadTextFileResponse{}, fmt.Errorf("ACP client capability not granted")
}

func (c *desktopACPClient) CreateTerminal(_ context.Context, _ acp.CreateTerminalRequest) (acp.CreateTerminalResponse, error) {
	return acp.CreateTerminalResponse{}, fmt.Errorf("ACP client capability not granted")
}

func (c *desktopACPClient) TerminalOutput(_ context.Context, _ acp.TerminalOutputRequest) (acp.TerminalOutputResponse, error) {
	return acp.TerminalOutputResponse{}, fmt.Errorf("ACP client capability not granted")
}

func (c *desktopACPClient) ReleaseTerminal(_ context.Context, _ acp.ReleaseTerminalRequest) (acp.ReleaseTerminalResponse, error) {
	return acp.ReleaseTerminalResponse{}, fmt.Errorf("ACP client capability not granted")
}

func (c *desktopACPClient) WaitForTerminalExit(_ context.Context, _ acp.WaitForTerminalExitRequest) (acp.WaitForTerminalExitResponse, error) {
	return acp.WaitForTerminalExitResponse{}, fmt.Errorf("ACP client capability not granted")
}

func (c *desktopACPClient) KillTerminal(_ context.Context, _ acp.KillTerminalRequest) (acp.KillTerminalResponse, error) {
	return acp.KillTerminalResponse{}, fmt.Errorf("ACP client capability not granted")
}
