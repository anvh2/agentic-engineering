package main

import (
	"context"
	"fmt"
	"sync"

	"github.com/coder/acp-go-sdk"
)

// ACP callbacks are deliberately restricted until scoped filesystem and
// interactive permission support are implemented.
type desktopACPClient struct {
	mu sync.Mutex
	stream *chatStream
	commands []acp.AvailableCommand
	usage *acp.SessionUsageUpdate
}

func (c *desktopACPClient) RequestPermission(_ context.Context, _ acp.RequestPermissionRequest) (acp.RequestPermissionResponse, error) {
	return acp.RequestPermissionResponse{}, fmt.Errorf("permission requires explicit approval; unavailable in ACP preview")
}

func (c *desktopACPClient) SessionUpdate(_ context.Context, n acp.SessionNotification) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if n.Update.AvailableCommandsUpdate != nil {
		c.commands = n.Update.AvailableCommandsUpdate.AvailableCommands
	}
	if n.Update.UsageUpdate != nil {
		c.usage = n.Update.UsageUpdate
	}
	if c.stream == nil {
		return nil
	}
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

// An adapter is long-lived for a conversation; callbacks are scoped to the
// currently executing turn. A nil stream discards late idle notifications.
func (c *desktopACPClient) setStream(stream *chatStream) {
	c.mu.Lock()
	c.stream = stream
	c.mu.Unlock()
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
