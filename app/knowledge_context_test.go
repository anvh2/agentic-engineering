package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeKnowledgeFixture(t *testing.T, entries []KnowledgeEntry, documents map[string]string) string {
	t.Helper()
	root:=t.TempDir()
	for path,content:=range documents{
		file:=filepath.Join(root,path)
		if err:=os.MkdirAll(filepath.Dir(file),0700);err!=nil{t.Fatal(err)}
		if err:=os.WriteFile(file,[]byte(content),0600);err!=nil{t.Fatal(err)}
	}
	manifest:=KnowledgePack{SchemaVersion:1,ID:"fixture-knowledge",Version:"1",Status:"approved",Entries:entries}
	raw,err:=json.Marshal(manifest);if err!=nil{t.Fatal(err)}
	if err=os.WriteFile(filepath.Join(root,"manifest.json"),raw,0600);err!=nil{t.Fatal(err)}
	return root
}
func TestBuildKnowledgeContextSelectsByRoleAndLanguage(t *testing.T){
	entries:=[]KnowledgeEntry{
		{ID:"dna",Path:"knowledge/ENGINEERING.md",Kind:"engineering",Load:"bootstrap",Status:"draft"},
		{ID:"developer",Path:"knowledge/roles/developer/ROLE.md",Kind:"roles",Load:"bootstrap",Roles:[]string{"developer"}},
		{ID:"reviewer",Path:"knowledge/roles/reviewer/ROLE.md",Kind:"roles",Load:"bootstrap",Roles:[]string{"reviewer"}},
		{ID:"go-standard",Path:"knowledge/standards/go/STANDARD.md",Kind:"standards",Load:"bootstrap",Roles:[]string{"developer"},Languages:[]string{"go"}},
		{ID:"ts-standard",Path:"knowledge/standards/typescript/STANDARD.md",Kind:"standards",Load:"bootstrap",Roles:[]string{"developer"},Languages:[]string{"typescript"}},
		{ID:"skill",Title:"Debugging",Description:"Use when debugging",Path:"knowledge/skills/debugging/SKILL.md",Kind:"skills",Load:"on-demand",Roles:[]string{"developer"}},
		{ID:"reference",Path:"knowledge/references/secret.md",Kind:"references",Load:"on-demand",Roles:[]string{"reviewer"}},
	}
	docs:=map[string]string{}
	for _,e:=range entries{docs[e.Path]="# "+e.ID}
	docs["knowledge/ENGINEERING.md"]="---\ntitle: Core\n---\n# DNA"
	root:=writeKnowledgeFixture(t,entries,docs)
	ctx,err:=BuildKnowledgeContext(KnowledgeContextRequest{AgentID:"emma",Root:root,Role:"Developer",Languages:[]string{"go"},Assigned:[]string{"skill"}})
	if err!=nil{t.Fatal(err)}
	defer os.RemoveAll(ctx.Directory)
	if len(ctx.Loaded)!=3{t.Fatalf("bootstrap=%v",ctx.Loaded)}
	if !strings.Contains(ctx.Bootstrap,"# DNA")||strings.Contains(ctx.Bootstrap,"title: Core"){t.Errorf("frontmatter or body mismatch: %s",ctx.Bootstrap)}
	if strings.Contains(ctx.Bootstrap,"ts-standard")||strings.Contains(ctx.Bootstrap,"reviewer")||strings.Contains(ctx.Bootstrap,"# skill"){t.Errorf("overloaded bootstrap: %s",ctx.Bootstrap)}
	if len(ctx.Available)!=1||ctx.Available[0]!="skill"{t.Fatalf("on demand=%v",ctx.Available)}
	if _,err:=os.Stat(filepath.Join(ctx.Directory,"knowledge/skills/debugging/SKILL.md"));err!=nil{t.Fatal(err)}
	if _,err:=os.Stat(filepath.Join(ctx.Directory,"knowledge/references/secret.md"));!os.IsNotExist(err){t.Fatalf("unassigned document exposed: %v",err)}
	if _,err:=os.Stat(filepath.Join(ctx.Directory,"knowledge/standards/typescript/STANDARD.md"));!os.IsNotExist(err){t.Fatalf("irrelevant standard exposed: %v",err)}
	injected,available:=0,0
	for _,e:=range ctx.Events{
		if e.Kind=="knowledge.injected"{injected++;if e.SHA256==""{t.Error("missing content hash")}}
		if e.Kind=="knowledge.available"{available++}
	}
	if injected!=3||available!=1{t.Fatalf("events=%+v",ctx.Events)}
}
func TestBuildKnowledgeContextRejectsInvalidAssignment(t *testing.T){
	e:=[]KnowledgeEntry{{ID:"dna",Path:"dna.md",Load:"bootstrap"},{ID:"review",Path:"review.md",Load:"on-demand",Roles:[]string{"reviewer"}}}
	root:=writeKnowledgeFixture(t,e,map[string]string{"dna.md":"Hello","review.md":"Review"})
	_,err:=BuildKnowledgeContext(KnowledgeContextRequest{Root:root,Role:"developer",Assigned:[]string{"review"}})
	if err==nil{t.Fatal("expected rejection for foreign role")}
	_,err=BuildKnowledgeContext(KnowledgeContextRequest{Root:root,Role:"developer",Assigned:[]string{"missing"}})
	if err==nil{t.Fatal("expected rejection for missing assignment")}
}
func TestBuildKnowledgeContextEnforcesBodyBudget(t *testing.T){
	content:="---\ntitle: Test\n---\n"+strings.Repeat("x",knowledgeBootstrapLimit+1)
	root:=writeKnowledgeFixture(t,[]KnowledgeEntry{{ID:"dna",Path:"dna.md",Load:"bootstrap"}},map[string]string{"dna.md":content})
	_,err:=BuildKnowledgeContext(KnowledgeContextRequest{Root:root})
	if err==nil||!strings.Contains(err.Error(),"24 KB"){t.Fatalf("expected bootstrap limit error, got %v",err)}
}
func TestBuildKnowledgeContextVerifiesHash(t *testing.T){
	root:=writeKnowledgeFixture(t,[]KnowledgeEntry{{ID:"dna",Path:"dna.md",Load:"bootstrap",SHA256:"0000"}},map[string]string{"dna.md":"real"})
	_,err:=BuildKnowledgeContext(KnowledgeContextRequest{Root:root})
	if err==nil||!strings.Contains(err.Error(),"checksum"){t.Fatalf("expected checksum error, got %v",err)}
}
func TestChatStreamNativeUsage(t *testing.T){
	for _,tc:=range []struct{name,line string;wantIn,wantOut,wantCache int64}{
		{"Claude",`{"type":"result","result":"done","usage":{"input_tokens":128,"output_tokens":32,"cache_read_input_tokens":60,"cache_creation_input_tokens":7}}`,128,32,60},
		{"Codex",`{"type":"turn.completed","usage":{"input_tokens":300,"output_tokens":45,"cached_input_tokens":250}}`,300,45,250},
	}{
		stream:=&chatStream{name:tc.name}
		if _,err:=stream.Write([]byte(tc.line+"\n"));err!=nil{t.Fatal(err)}
		if stream.usage==nil||stream.usage.InputTokens!=tc.wantIn||stream.usage.OutputTokens!=tc.wantOut||stream.usage.CacheReadTokens!=tc.wantCache{t.Errorf("%s usage=%+v",tc.name,stream.usage)}
	}
}
