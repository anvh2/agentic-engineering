package main

import (
 "os"
 "path/filepath"
 "strings"
 "testing"
)

func TestParseKnowledgeGitHubURL(t *testing.T) {
 cases:=[]struct{url,repository,ref string}{
  {"https://github.com/anvh2/engineering-knowledge","https://github.com/anvh2/engineering-knowledge","main"},
  {"https://github.com/anvh2/engineering-knowledge/tree/calibrate/go-backend-2026-11","https://github.com/anvh2/engineering-knowledge","calibrate/go-backend-2026-11"},
  {"https://github.com/owner/repo/releases/tag/v1.2.3","https://github.com/owner/repo","v1.2.3"},
 }
 for _,tc:=range cases{
  repository,ref,err:=parseKnowledgeGitHubURL(tc.url)
  if err!=nil || repository!=tc.repository || ref!=tc.ref {t.Errorf("%q: repository=%q ref=%q err=%v",tc.url,repository,ref,err)}
 }
 for _,u:=range []string{
  "https://evil.example/owner/repo",
  "https://github.com/owner/repo/tree/../../evil",
  "https://github.com/owner/repo?foo=bar",
  "https://github.com/owner/repo/blob/main/README.md",
 } {
  if _,_,err:=parseKnowledgeGitHubURL(u);err==nil {t.Errorf("accepted unsafe URL %q",u)}
 }
}

func TestImportJSONAndRead(t *testing.T) {
 // Unique fixture avoids collisions with other local knowledge sources.
 input:=`{"schemaVersion":1,"id":"unit-test-inline-pack","version":"1","status":"draft","entries":[{"id":"unit-test-skill","title":"Unit skill","path":"skills/unit/SKILL.md","kind":"skills","content":"# Unit skill"}]}`
 source:=&KnowledgeSource{}
 pack,err:=source.ImportJSON(input)
 if err!=nil{t.Fatal(err)}
 t.Cleanup(func(){os.RemoveAll(pack.Root)})
 if pack.Ref!="inline-json" || pack.ID!="unit-test-inline-pack" || pack.Entries[0].Bytes==0{t.Fatalf("unexpected pack: %+v",pack)}
 document,err:=source.ReadEntry(pack.Root,"unit-test-skill")
 if err!=nil || document!="# Unit skill"{t.Fatalf("document=%q err=%v",document,err)}
 if _,err:=os.Stat(filepath.Join(pack.Root,"skills","unit","SKILL.md"));err!=nil{t.Fatal(err)}
 missing:=strings.Replace(input,`"content":"# Unit skill"`,`"description":"Missing document content"`,1)
 if _,err:=source.ImportJSON(missing);err==nil{t.Error("accepted manifest without document content")}
 traversal:=strings.Replace(input,"skills/unit/SKILL.md","../outside.md",1)
 if _,err:=source.ImportJSON(traversal);err==nil{t.Error("accepted traversal path")}
}

func TestLoadLocalGenericManifest(t *testing.T) {
 root:=t.TempDir()
 if err:=os.WriteFile(filepath.Join(root,"README.md"),[]byte("# Test"),0600);err!=nil{t.Fatal(err)}
 manifest:=`{"schemaVersion":1,"id":"custom-pack","version":"1","entries":[{"id":"readme","path":"README.md","kind":"references"}]}`
 if err:=os.WriteFile(filepath.Join(root,"manifest.json"),[]byte(manifest),0600);err!=nil{t.Fatal(err)}
 source:=&KnowledgeSource{}
 p,err:=source.LoadLocal(root)
 if err!=nil || p.ID!="custom-pack" || p.Entries[0].Bytes!=6{t.Fatalf("pack=%+v err=%v",p,err)}
}
