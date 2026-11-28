// Package team is the registry of Team agents. Agent identity is independent of
// the native harness: several agents may share one harness, and nothing here
// assumes a particular name, role or assignment.
package team

import (
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
)

// Native harnesses an agent may run on, as the Team UI names them.
const (
	HarnessClaude = "Claude"
	HarnessCodex  = "Codex"
)

const maxIDBytes = 128

var handlePattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,39}$`)

// Profile is one Team agent's configuration.
type Profile struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Handle        string   `json:"handle"`
	Role          string   `json:"role"`
	Harness       string   `json:"harness"`
	Model         string   `json:"model"`
	KnowledgeRoot string   `json:"knowledgeRoot"`
	Languages     []string `json:"languages"`
	Assigned      []string `json:"assigned"`
}

// Rejection explains why a profile was not registered.
type Rejection struct {
	ID     string `json:"id"`
	Reason string `json:"reason"`
}

// Registry holds the current Team in memory. It is safe for concurrent use.
type Registry struct {
	mu     sync.RWMutex
	agents map[string]Profile
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry { return &Registry{agents: map[string]Profile{}} }

// Replace atomically swaps the whole Team. Invalid profiles are left out and
// reported; profiles sharing an ID or handle are all rejected, because an
// assignment must resolve to exactly one agent.
func (r *Registry) Replace(profiles []Profile) []Rejection {
	ids, handles := map[string]int{}, map[string]int{}
	for _, p := range profiles {
		ids[p.ID]++
		handles[p.Handle]++
	}
	agents := make(map[string]Profile, len(profiles))
	rejections := []Rejection{}
	for _, p := range profiles {
		reason := validate(p)
		if reason == "" && ids[p.ID] > 1 {
			reason = "agent ID is not unique"
		}
		if reason == "" && handles[p.Handle] > 1 {
			reason = "handle is not unique"
		}
		if reason != "" {
			rejections = append(rejections, Rejection{ID: p.ID, Reason: reason})
			continue
		}
		agents[p.ID] = clone(p)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.agents = agents
	return rejections
}

// Get returns a copy of the agent with the given ID.
func (r *Registry) Get(id string) (Profile, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.agents[id]
	return clone(p), ok
}

func validate(p Profile) string {
	if p.ID == "" || len(p.ID) > maxIDBytes || strings.TrimSpace(p.ID) != p.ID {
		return "agent ID is required"
	}
	if strings.TrimSpace(p.Name) == "" {
		return "name is required"
	}
	if !handlePattern.MatchString(p.Handle) || p.Handle == "human" || p.Handle == "system" {
		return "handle must be 1-40 lowercase letters, digits, - or _, and not reserved"
	}
	if strings.TrimSpace(p.Role) == "" {
		return "role is required"
	}
	if p.Harness != HarnessClaude && p.Harness != HarnessCodex {
		return "unsupported harness"
	}
	if p.KnowledgeRoot != "" && !filepath.IsAbs(p.KnowledgeRoot) {
		return "knowledge source must be an absolute path"
	}
	return ""
}

func clone(p Profile) Profile {
	p.Languages = slices.Clone(p.Languages)
	p.Assigned = slices.Clone(p.Assigned)
	return p
}
