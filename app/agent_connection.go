package main

import "github.com/anvh2/agentic-engineering/app/internal/agentdiscovery"

// AgentConnection exposes read-only native CLI diagnostics to the desktop.
type AgentConnection struct{}

func (a *AgentConnection) ScanAgent(name, path string) agentdiscovery.Status {
 return agentdiscovery.Scan(name,path)
}
