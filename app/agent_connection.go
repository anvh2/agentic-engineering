package main

import "github.com/anvh2/agentic-engineering/app/internal/discovery"

// AgentConnection exposes read-only native CLI diagnostics to the desktop.
type AgentConnection struct{}

func (a *AgentConnection) ScanAgent(name, path string) discovery.Status {
 return discovery.Scan(name,path)
}
