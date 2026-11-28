package main

import (
 "context"
 "crypto/sha256"
 "sort"
 "net/url"
 "regexp"
 "encoding/json"
 "errors"
 "fmt"
 "os"
 "os/exec"
 "path/filepath"
 "strings"
 "time"
)

const knowledgeRepository = "https://github.com/anvh2/engineering-knowledge.git"

type KnowledgeGroup struct {
 ID string `json:"id"`
 Title string `json:"title"`
}

type KnowledgeEntry struct {
 Group string `json:"group,omitempty"`
 Capabilities []string `json:"capabilities,omitempty"`
 ID string `json:"id"`
 Title string `json:"title,omitempty"`
 Description string `json:"description,omitempty"`
 Path string `json:"path"`
 Kind string `json:"kind"`
 Load string `json:"load,omitempty"`
 Status string `json:"status,omitempty"`
 Roles []string `json:"roles,omitempty"`
 Languages []string `json:"languages,omitempty"`
 SHA256 string `json:"sha256,omitempty"`
 Bytes int64 `json:"bytes"`
 Tokens int64 `json:"tokens"`
}
type KnowledgePack struct {
 Groups []KnowledgeGroup `json:"groups,omitempty"`
 SchemaVersion int `json:"schemaVersion"`
 ID string `json:"id"`
 Version string `json:"version"`
 Status string `json:"status"`
 Language string `json:"language"`
 Entries []KnowledgeEntry `json:"entries"`
 Root string `json:"root"`
 Ref string `json:"ref"`
 Repository string `json:"repository,omitempty"`
 Manifest string `json:"manifest,omitempty"`
}
type KnowledgeSource struct{}

func knowledgeSafeFile(root, rel string) (string,error) {
 if filepath.IsAbs(rel) || rel=="" {return "",errors.New("invalid knowledge path")}
 clean:=filepath.Clean(rel)
 if clean==".." || strings.HasPrefix(clean,".."+string(os.PathSeparator)){return "",errors.New("knowledge path escapes source")}
 base,err:=filepath.EvalSymlinks(root);if err!=nil{return "",err}
 path,err:=filepath.EvalSymlinks(filepath.Join(base,clean));if err!=nil{return "",err}
 relative,err:=filepath.Rel(base,path);if err!=nil || relative==".." || strings.HasPrefix(relative,".."+string(os.PathSeparator)){return "",errors.New("knowledge entry escapes source")}
 return path,nil
}

// LoadLocal reads a previously cloned repository. It does not write or execute knowledge.
func (s *KnowledgeSource) LoadLocal(path string) (KnowledgePack,error) {
 var p KnowledgePack
 if strings.TrimSpace(path)=="" {return p,errors.New("enter a local engineering-knowledge directory")}
 root,err:=filepath.Abs(path);if err!=nil{return p,err}
 manifest:="manifest.json"
 if strings.EqualFold(filepath.Ext(root),".json"){manifest=filepath.Base(root);root=filepath.Dir(root)}
 file,err:=knowledgeSafeFile(root,manifest);if err!=nil{return p,err}
 raw,err:=os.ReadFile(file);if err!=nil{return p,err}
 if len(raw)>1024*1024{return p,errors.New("manifest is too large")}
 if err=json.Unmarshal(raw,&p);err!=nil{return p,fmt.Errorf("invalid manifest: %w",err)}
 if p.SchemaVersion!=1 || strings.TrimSpace(p.ID)=="" || len(p.Entries)==0 || len(p.Entries)>500{return KnowledgePack{},errors.New("unsupported engineering-knowledge manifest")}
 seen:=make(map[string]bool,len(p.Entries))
 for i:=range p.Entries {
  e:=&p.Entries[i]
  if e.ID=="" || seen[e.ID] {return KnowledgePack{},errors.New("duplicate or empty knowledge ID")}
  seen[e.ID]=true
  file,err:=knowledgeSafeFile(root,e.Path);if err!=nil{return KnowledgePack{},fmt.Errorf("knowledge entry %s: %w",e.ID,err)}
  stat,err:=os.Stat(file);if err!=nil{return KnowledgePack{},err}
  if !stat.Mode().IsRegular() || stat.Size()>2*1024*1024 {return KnowledgePack{},fmt.Errorf("invalid document size: %s",e.ID)}
  e.Bytes=stat.Size()
  e.Tokens=(stat.Size()+3)/4 // Coarse display estimate, not a model tokenizer.
 }
 p.Root=root
 p.Manifest=manifest
 p.Ref="local"
 return p,nil
}

// SyncGitHub uses the user's existing Git credentials; no token is stored in the app.
func (s *KnowledgeSource) SyncGitHub(ref string) (KnowledgePack,error) {
 return s.SyncRepository(knowledgeRepository,ref,"manifest.json")
}

// SyncRepository accepts HTTPS GitHub repository URLs only.

// parseKnowledgeGitHubURL accepts repository URLs, /tree/<branch> and /releases/tag/<tag>.
func parseKnowledgeGitHubURL(raw string) (string,string,error) {
 u,err:=url.Parse(strings.TrimSpace(raw))
 if err!=nil || u.Scheme!="https" || !strings.EqualFold(u.Host,"github.com") || u.User!=nil || u.RawQuery!="" || u.Fragment!="" {return "","",errors.New("enter an HTTPS github.com repository URL")}
 parts:=strings.Split(strings.Trim(u.EscapedPath(),"/"),"/")
 valid:=regexp.MustCompile("^[A-Za-z0-9_.-]+$")
 if len(parts)<2 || !valid.MatchString(parts[0]) || !valid.MatchString(strings.TrimSuffix(parts[1],".git")) {return "","",errors.New("invalid GitHub owner/repository")}
 repo:="https://github.com/"+parts[0]+"/"+strings.TrimSuffix(parts[1],".git")
 ref:="main"
 if len(parts)>2 {
  if len(parts)>3 && parts[2]=="tree" {ref=strings.Join(parts[3:],"/")
  } else if len(parts)>4 && parts[2]=="releases" && parts[3]=="tag" {ref=strings.Join(parts[4:],"/")
  } else {return "","",errors.New("use a repository URL, /tree/<branch>, or /releases/tag/<tag>")}
 }
 if err:=validateKnowledgeRef(ref);err!=nil{return "","",err}
 return repo,ref,nil
}
func validateKnowledgeRef(ref string) error {
 if len(ref)==0 || len(ref)>255 || strings.HasPrefix(ref,"-") || strings.HasPrefix(ref,"/") || strings.HasSuffix(ref,"/") || strings.Contains(ref,"..") || strings.Contains(ref,"//") || strings.Contains(ref,"@{") || strings.HasSuffix(ref,".lock") {return errors.New("invalid Git branch or tag")}
 for _,part:=range strings.Split(ref,"/"){if part=="." || strings.HasPrefix(part,".") || strings.HasSuffix(part,".") {return errors.New("invalid Git branch or tag")}}
 for _,ch:=range ref {if !((ch>='A'&&ch<='Z')||(ch>='a'&&ch<='z')||(ch>='0'&&ch<='9')||strings.ContainsRune("_./-",ch)){return errors.New("invalid Git branch or tag")}}
 return nil
}

// SyncRepository accepts a full GitHub URL. Empty ref uses the ref in the URL (default main).
// The manifest filename remains manifest.json until nested manifests are supported.
func (s *KnowledgeSource) SyncRepository(rawURL,selectedRef,manifest string) (KnowledgePack,error) {
 repo,ref,err:=parseKnowledgeGitHubURL(rawURL);if err!=nil{return KnowledgePack{},err}
 if selectedRef!="" {if err:=validateKnowledgeRef(selectedRef);err!=nil{return KnowledgePack{},err};ref=selectedRef}
 if manifest!="" && manifest!="manifest.json" {return KnowledgePack{},errors.New("GitHub source requires root manifest.json")}
 cache,err:=os.UserCacheDir();if err!=nil{return KnowledgePack{},err}
 parent:=filepath.Join(cache,"agentic-engineering","knowledge")
 if err:=os.MkdirAll(parent,0700);err!=nil{return KnowledgePack{},err}
 folder:=fmt.Sprintf("%x",sha256.Sum256([]byte(repo+"\x00"+ref)))
 root:=filepath.Join(parent,folder)
 ctx,cancel:=context.WithTimeout(context.Background(),120*time.Second);defer cancel()
 if _,err:=os.Stat(root);os.IsNotExist(err) {
  temp,err:=os.MkdirTemp(parent,"clone-*");if err!=nil{return KnowledgePack{},err}
  defer os.RemoveAll(temp)
  target:=filepath.Join(temp,"repo")
  cmd:=exec.CommandContext(ctx,"git","clone","--depth=1","--branch",ref,"--quiet",repo+".git",target)
  cmd.Env=append(os.Environ(),"GIT_TERMINAL_PROMPT=0")
  if out,err:=cmd.CombinedOutput();err!=nil{return KnowledgePack{},fmt.Errorf("Git clone failed: %s: %w",strings.TrimSpace(string(out)),err)}
  if err:=os.Rename(target,root);err!=nil{return KnowledgePack{},err}
 }else if err!=nil{return KnowledgePack{},err
 }else{
  cmd:=exec.CommandContext(ctx,"git","-C",root,"fetch","--quiet","--depth=1","origin",ref)
  cmd.Env=append(os.Environ(),"GIT_TERMINAL_PROMPT=0")
  if out,err:=cmd.CombinedOutput();err!=nil{return KnowledgePack{},fmt.Errorf("Git fetch failed: %s: %w",strings.TrimSpace(string(out)),err)}
  cmd=exec.CommandContext(ctx,"git","-C",root,"reset","--hard","FETCH_HEAD")
  if out,err:=cmd.CombinedOutput();err!=nil{return KnowledgePack{},fmt.Errorf("Git reset failed: %s: %w",strings.TrimSpace(string(out)),err)}
 }
 p,err:=s.LoadLocal(root);if err!=nil{return p,err}
 p.Ref=ref;p.Repository=repo;p.Manifest="manifest.json"
 return p,nil
}
type GitRef struct {Name string `json:"name"`; Kind string `json:"kind"`}
// ListGitRefs uses read-only Git discovery; it does not checkout or run repository scripts.
func (s *KnowledgeSource) ListGitRefs(rawURL string)([]GitRef,error){
 repo,_,err:=parseKnowledgeGitHubURL(rawURL);if err!=nil{return nil,err}
 ctx,cancel:=context.WithTimeout(context.Background(),30*time.Second);defer cancel()
 cmd:=exec.CommandContext(ctx,"git","ls-remote","--refs","--heads","--tags",repo+".git")
 cmd.Env=append(os.Environ(),"GIT_TERMINAL_PROMPT=0")
 out,err:=cmd.Output();if err!=nil{return nil,fmt.Errorf("cannot list Git branches/tags: %w",err)}
 refs:=make([]GitRef,0,64)
 for _,line:=range strings.Split(string(out),"\n"){
  fields:=strings.Fields(line);if len(fields)!=2{continue}
  kind,name:="",""
  if strings.HasPrefix(fields[1],"refs/heads/"){kind="branch";name=strings.TrimPrefix(fields[1],"refs/heads/")}
  if strings.HasPrefix(fields[1],"refs/tags/"){kind="tag";name=strings.TrimPrefix(fields[1],"refs/tags/")}
  if kind!="" && validateKnowledgeRef(name)==nil{refs=append(refs,GitRef{Name:name,Kind:kind})}
  if len(refs)>=1000{break}
 }
 sort.Slice(refs,func(i,j int)bool{if refs[i].Kind!=refs[j].Kind{return refs[i].Kind<refs[j].Kind};return refs[i].Name<refs[j].Name})
 return refs,nil
}
// ImportJSON stores self-contained JSON manifests where every entry includes a content string.
// Path-only manifests must be imported by repository URL so files can be read.
func (s *KnowledgeSource) ImportJSON(raw string)(KnowledgePack,error){
 if len(raw)==0 || len(raw)>8<<20{return KnowledgePack{},errors.New("JSON is empty or too large")}
 var p KnowledgePack
 if err:=json.Unmarshal([]byte(raw),&p);err!=nil{return p,fmt.Errorf("invalid JSON: %w",err)}
 if p.SchemaVersion!=1 || strings.TrimSpace(p.ID)=="" || len(p.Entries)==0 || len(p.Entries)>500{return KnowledgePack{},errors.New("unsupported manifest")}
 var payload struct{Entries []struct{ID string `json:"id"`;Path string `json:"path"`;Content *string `json:"content"`} `json:"entries"`}
 if err:=json.Unmarshal([]byte(raw),&payload);err!=nil{return KnowledgePack{},err}
 if len(payload.Entries)!=len(p.Entries){return KnowledgePack{},errors.New("invalid manifest entries")}
 cache,err:=os.UserCacheDir();if err!=nil{return KnowledgePack{},err}
 parent:=filepath.Join(cache,"agentic-engineering","knowledge","inline-json")
 if err:=os.MkdirAll(parent,0700);err!=nil{return KnowledgePack{},err}
 root:=filepath.Join(parent,fmt.Sprintf("%x",sha256.Sum256([]byte(raw))))
 if _,err:=os.Stat(root);err==nil {p,err:=s.LoadLocal(root);if err==nil{p.Ref="inline-json"};return p,err}else if !os.IsNotExist(err){return KnowledgePack{},err}
 temp,err:=os.MkdirTemp(parent,"import-*");if err!=nil{return KnowledgePack{},err}
 defer os.RemoveAll(temp)
 seenID,seenPath:=map[string]bool{},map[string]bool{}
 for i,e:=range payload.Entries{
  if e.ID=="" || e.ID!=p.Entries[i].ID || e.Path!=p.Entries[i].Path || seenID[e.ID] || seenPath[e.Path]{return KnowledgePack{},errors.New("duplicate or invalid document ID/path")}
  seenID[e.ID]=true;seenPath[e.Path]=true
  if e.Content==nil{return KnowledgePack{},fmt.Errorf("document %s has no content; use GitHub URL for path-only manifests",e.ID)}
  if len(*e.Content)>2<<20{return KnowledgePack{},fmt.Errorf("document %s is too large",e.ID)}
  if filepath.IsAbs(e.Path) || e.Path=="" || strings.Contains(e.Path,"\\"){return KnowledgePack{},errors.New("invalid document path")}
  clean:=filepath.Clean(e.Path)
  if clean=="." || clean==".." || strings.HasPrefix(clean,".."+string(os.PathSeparator)) || clean=="manifest.json" || clean==".git" || strings.HasPrefix(clean,".git"+string(os.PathSeparator)){return KnowledgePack{},errors.New("unsafe document path")}
  path:=filepath.Join(temp,clean)
  if err:=os.MkdirAll(filepath.Dir(path),0700);err!=nil{return KnowledgePack{},err}
  if err:=os.WriteFile(path,[]byte(*e.Content),0600);err!=nil{return KnowledgePack{},err}
 }
 p.Root="";p.Repository="";p.Ref="";p.Manifest=""
 manifest,err:=json.Marshal(p);if err!=nil{return KnowledgePack{},err}
 if err:=os.WriteFile(filepath.Join(temp,"manifest.json"),manifest,0600);err!=nil{return KnowledgePack{},err}
 if err:=os.Rename(temp,root);err!=nil{return KnowledgePack{},err}
 p,err=s.LoadLocal(root);if err!=nil{return p,err}
 p.Ref="inline-json";return p,nil
}
// ReadEntry resolves an ID through the manifest, never through an unchecked path.
func (s *KnowledgeSource) ReadEntry(root,id string)(string,error){
 p,err:=s.LoadLocal(root);if err!=nil{return "",err}
 for _,e:=range p.Entries{
  if e.ID!=id{continue}
  file,err:=knowledgeSafeFile(p.Root,e.Path);if err!=nil{return "",err}
  raw,err:=os.ReadFile(file);if err!=nil{return "",err}
  return string(raw),nil
 }
 return "",errors.New("document ID not found")
}
