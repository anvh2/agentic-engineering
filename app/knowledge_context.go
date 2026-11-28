package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const knowledgeBootstrapLimit = 24 * 1024

type KnowledgeContextRequest struct {
	AgentID   string   `json:"agentId"`
	Root      string   `json:"root"`
	Role      string   `json:"role"`
	Languages []string `json:"languages"`
	Assigned  []string `json:"assigned"`
	Task      string   `json:"task"`
}

type KnowledgeTraceEvent struct {
	RunID            string `json:"runId,omitempty"`
	AgentID          string `json:"agentId,omitempty"`
	At               string `json:"at,omitempty"`
	Kind             string `json:"kind"`
	DocumentID       string `json:"documentId,omitempty"`
	Status           string `json:"status,omitempty"`
	Reason           string `json:"reason,omitempty"`
	SHA256           string `json:"sha256,omitempty"`
	EstimatedTokens  int64  `json:"estimatedTokens,omitempty"`
	InputTokens      int64  `json:"inputTokens,omitempty"`
	OutputTokens     int64  `json:"outputTokens,omitempty"`
	CacheReadTokens  int64  `json:"cacheReadTokens,omitempty"`
	CacheWriteTokens int64  `json:"cacheWriteTokens,omitempty"`
}

type KnowledgeContext struct {
	Bootstrap       string                `json:"bootstrap"`
	Index           string                `json:"index"`
	Directory       string                `json:"directory"`
	EstimatedTokens int64                 `json:"estimatedTokens"`
	Events          []KnowledgeTraceEvent `json:"events"`
	Loaded          []string              `json:"loaded"`
	Available       []string              `json:"available"`
}

type selectedKnowledge struct {
	entry KnowledgeEntry
	body  []byte
	hash  string
}

func knowledgeMarkdownBody(raw []byte) []byte {
	text := string(raw)
	if !strings.HasPrefix(text, "---\n") {
		return raw
	}
	closing := strings.Index(text[4:], "\n---\n")
	if closing == -1 {
		return raw
	}
	return []byte(text[4+closing+5:])
}

// A missing roles or languages filter applies to every role or language.
// The contract comes from engineering-knowledge/main, not inferred file paths.
func knowledgeApplicable(entry KnowledgeEntry, role string, languages []string) bool {
	if len(entry.Roles) > 0 {
		matched := false
		for _, allowed := range entry.Roles {
			if strings.EqualFold(strings.TrimSpace(allowed), strings.TrimSpace(role)) {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	if len(entry.Languages) == 0 {
		return true
	}
	for _, language := range languages {
		for _, allowed := range entry.Languages {
			if strings.EqualFold(strings.TrimSpace(language), strings.TrimSpace(allowed)) {
				return true
			}
		}
	}
	return false
}

func selectKnowledge(pack KnowledgePack, request KnowledgeContextRequest) ([]KnowledgeEntry, error) {
	assigned := make(map[string]bool, len(request.Assigned))
	for _, id := range request.Assigned {
		assigned[id] = true
	}
	selected := make([]KnowledgeEntry, 0, len(pack.Entries))
	for _, entry := range pack.Entries {
		if !knowledgeApplicable(entry, request.Role, request.Languages) {
			continue
		}
		if entry.Load == "bootstrap" || (entry.Load == "on-demand" && assigned[entry.ID]) {
			selected = append(selected, entry)
			delete(assigned, entry.ID)
		}
	}
	for id := range assigned {
		return nil, fmt.Errorf("knowledge assignment %q is missing or not applicable", id)
	}
	if len(selected) == 0 {
		return nil, errors.New("no applicable knowledge documents")
	}
	sort.SliceStable(selected, func(i, j int) bool {
		return selected[i].ID < selected[j].ID
	})
	return selected, nil
}

func readSelectedKnowledge(ctx context.Context, root string, entries []KnowledgeEntry) ([]selectedKnowledge, error) {
	result := make([]selectedKnowledge, 0, len(entries))
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		path, err := knowledgeSafeFile(root, entry.Path)
		if err != nil {
			return nil, fmt.Errorf("resolve document %s: %w", entry.ID, err)
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read document %s: %w", entry.ID, err)
		}
		digest := sha256.Sum256(raw)
		hash := hex.EncodeToString(digest[:])
		if entry.SHA256 != "" && !strings.EqualFold(hash, entry.SHA256) {
			return nil, fmt.Errorf("knowledge checksum mismatch: %s", entry.ID)
		}
		result = append(result, selectedKnowledge{entry: entry, body: raw, hash: hash})
	}
	return result, nil
}

func safeKnowledgeRelativePath(path string) (string, error) {
	if path == "" || filepath.IsAbs(path) || strings.Contains(path, "\\") {
		return "", errors.New("invalid knowledge path")
	}
	clean := filepath.Clean(path)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(os.PathSeparator)) {
		return "", errors.New("knowledge path escapes source")
	}
	if clean == ".git" || strings.HasPrefix(clean, ".git"+string(os.PathSeparator)) {
		return "", errors.New("git control path is not a knowledge document")
	}
	return clean, nil
}

func materializeKnowledge(docs []selectedKnowledge) (string, error) {
	dir, err := os.MkdirTemp("", "ae-knowledge-*")
	if err != nil {
		return "", fmt.Errorf("create knowledge directory: %w", err)
	}
	keep := false
	defer func() {
		if !keep {
			_ = os.RemoveAll(dir)
		}
	}()
	for _, doc := range docs {
		rel, err := safeKnowledgeRelativePath(doc.entry.Path)
		if err != nil {
			return "", fmt.Errorf("document %s: %w", doc.entry.ID, err)
		}
		target := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return "", fmt.Errorf("create knowledge document directory: %w", err)
		}
		if err := os.WriteFile(target, doc.body, 0600); err != nil {
			return "", fmt.Errorf("write knowledge document %s: %w", doc.entry.ID, err)
		}
	}
	keep = true
	return dir, nil
}

// BuildKnowledgeContext is deterministic, cancellable and requires no model or MCP.
// The caller owns cleanup of the optional per-run Directory.
func BuildKnowledgeContext(ctx context.Context, request KnowledgeContextRequest) (KnowledgeContext, error) {
	var result KnowledgeContext
	if strings.TrimSpace(request.Root) == "" {
		return result, errors.New("knowledge root required")
	}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	pack, err := (&KnowledgeSource{}).LoadLocal(request.Root)
	if err != nil {
		return result, fmt.Errorf("load knowledge pack: %w", err)
	}
	entries, err := selectKnowledge(pack, request)
	if err != nil {
		return result, err
	}
	docs, err := readSelectedKnowledge(ctx, pack.Root, entries)
	if err != nil {
		return result, err
	}

	var (
		bootstrap      strings.Builder
		index          strings.Builder
		bootstrapBytes int
	)
	onDemand := make([]selectedKnowledge, 0, len(docs))
	for _, doc := range docs {
		entry := doc.entry
		event := KnowledgeTraceEvent{
			DocumentID:      entry.ID,
			Status:          entry.Status,
			SHA256:          doc.hash,
			EstimatedTokens: int64((len(doc.body) + 3) / 4),
		}
		if entry.Load == "bootstrap" {
			body := knowledgeMarkdownBody(doc.body)
			bootstrapBytes += len(body)
			if bootstrapBytes > knowledgeBootstrapLimit {
				return KnowledgeContext{}, errors.New("knowledge bootstrap body exceeds 24 KB limit")
			}
			fmt.Fprintf(&bootstrap, "\n--- %s (%s, %s) ---\n%s\n", entry.Title, entry.ID, entry.Status, body)
			result.Loaded = append(result.Loaded, entry.ID)
			event.Kind = "knowledge.injected"
		} else {
			onDemand = append(onDemand, doc)
			result.Available = append(result.Available, entry.ID)
			fmt.Fprintf(&index, "- %s | %s | %s | %s | %s\n", entry.ID, entry.Title, entry.Kind, entry.Description, entry.Path)
			event.Kind = "knowledge.available"
		}
		result.Events = append(result.Events, event)
	}
	result.Bootstrap = bootstrap.String()
	result.Index = index.String()
	result.EstimatedTokens = int64((len(result.Bootstrap) + len(result.Index) + 3) / 4)
	if len(onDemand) > 0 {
		result.Directory, err = materializeKnowledge(onDemand)
		if err != nil {
			return KnowledgeContext{}, err
		}
	}
	return result, nil
}
