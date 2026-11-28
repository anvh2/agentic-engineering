package main

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"
)

func TestNativeArgsScopedReadOnly(t *testing.T) {
	tests := []struct {
		name       string
		issue      string
		standalone bool
		want       []string
	}{
		{
			name:       "Claude",
			standalone: true,
			want: []string{
				"-p", "--tools", "Read,Grep,Glob",
				"--output-format", "stream-json", "--verbose", "--include-partial-messages",
			},
		},
		{
			name:       "Codex",
			standalone: true,
			want: []string{
				"exec", "--sandbox", "read-only", "--json", "--skip-git-repo-check", "-",
			},
		},
		{
			name:  "Codex",
			issue: "TASK-1",
			want:  []string{"exec", "--sandbox", "workspace-write", "--json", "-"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name+"/"+tt.issue, func(t *testing.T) {
			got := nativeArgs(tt.name, tt.issue, "", tt.standalone)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("args=%v, want=%v", got, tt.want)
			}
		})
	}
	if got := nativeArgs("Codex", "", "gpt-test", true); !slices.Contains(got, "gpt-test") {
		t.Fatalf("model override not passed: %v", got)
	}
}

func TestKnowledgeRelativePath(t *testing.T) {
	for _, path := range []string{"../other.md", "/etc/passwd", ".git/config", "a"+string(rune(92))+"b.md", ""} {
		if _, err := safeKnowledgeRelativePath(path); err == nil {
			t.Errorf("accepted unsafe path %q", path)
		}
	}
	got, err := safeKnowledgeRelativePath("knowledge/skills/debugging/SKILL.md")
	if err != nil || got != filepath.FromSlash("knowledge/skills/debugging/SKILL.md") {
		t.Fatalf("relative path=%q err=%v", got, err)
	}
}

func TestBuildKnowledgeContextCancelled(t *testing.T) {
	root := writeKnowledgeFixture(t, []KnowledgeEntry{
		{ID: "DNA", Path: "dna.md", Load: "bootstrap"},
	}, map[string]string{"dna.md": "content"})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := BuildKnowledgeContext(ctx, KnowledgeContextRequest{Root: root})
	if err != context.Canceled {
		t.Fatalf("expected context canceled, got %v", err)
	}
}

func TestMaterializeKnowledgeKeepsScope(t *testing.T) {
	dir, err := materializeKnowledge([]selectedKnowledge{
		{entry: KnowledgeEntry{ID: "skill", Path: "skills/debugging/SKILL.md"}, body: []byte("# Debugging")},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	path := filepath.Join(dir, "skills/debugging/SKILL.md")
	body, err := os.ReadFile(path)
	if err != nil || string(body) != "# Debugging" {
		t.Fatalf("materialized skill=%q err=%v", body, err)
	}
}
