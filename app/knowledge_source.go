package main

import (
 "context"
 "crypto/sha256"
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

type KnowledgeEntry struct {
 ID string `json:"id"`
 Title string `json:"title,omitempty"`
 Description string `json:"description,omitempty"`
 Path string `json:"path"`
 Kind string `json:"kind"`
 Load string `json:"load,omitempty"`
 Bytes int64 `json:"bytes"`
 Tokens int64 `json:"tokens"`
}
type KnowledgePack struct {
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
 if manifest!="manifest.json"{p.Root=filepath.Join(root,manifest)}
 p.Ref="local"
 return p,nil
}

// SyncGitHub uses the user's existing Git credentials; no token is stored in the app.
func (s *KnowledgeSource) SyncGitHub(ref string) (KnowledgePack,error) {
 return s.SyncRepository(knowledgeRepository,ref,"manifest.json")
}

// SyncRepository accepts HTTPS GitHub repository URLs only.
func (s *KnowledgeSource) SyncRepository(repository,ref,manifest string) (KnowledgePack,error) {
 u,err:=url.Parse(strings.TrimSpace(repository))
 if err!=nil || u.Scheme!="https" || u.Host!="github.com" || u.User!=nil || u.RawQuery!="" || u.Fragment!="" || !regexp.MustCompile(`^/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/?package main

import (
 "context"
 "crypto/sha256"
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

type KnowledgeEntry struct {
 ID string `json:"id"`
 Title string `json:"title,omitempty"`
 Description string `json:"description,omitempty"`
 Path string `json:"path"`
 Kind string `json:"kind"`
 Load string `json:"load,omitempty"`
 Bytes int64 `json:"bytes"`
 Tokens int64 `json:"tokens"`
}
type KnowledgePack struct {
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
).MatchString(u.Path) {return KnowledgePack{},errors.New("enter an HTTPS GitHub repository URL")}
 repository="https://github.com"+strings.TrimSuffix(strings.TrimSuffix(u.Path,"/"),".git")+".git"
 if ref==""{ref="main"}
 if strings.HasPrefix(ref,"-") || !regexp.MustCompile(`^[A-Za-z0-9_./-]+package main

import (
 "context"
 "crypto/sha256"
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

type KnowledgeEntry struct {
 ID string `json:"id"`
 Title string `json:"title,omitempty"`
 Description string `json:"description,omitempty"`
 Path string `json:"path"`
 Kind string `json:"kind"`
 Load string `json:"load,omitempty"`
 Bytes int64 `json:"bytes"`
 Tokens int64 `json:"tokens"`
}
type KnowledgePack struct {
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
).MatchString(ref) || strings.Contains(ref,".."){return KnowledgePack{},errors.New("invalid branch or tag")}
 if manifest==""{manifest="manifest.json"}
 if filepath.Base(manifest)!=manifest || !strings.EqualFold(filepath.Ext(manifest),".json"){return KnowledgePack{},errors.New("enter a JSON manifest filename at the repository root")}
 cache,err:=os.UserCacheDir();if err!=nil{return KnowledgePack{},err}
 parent:=filepath.Join(cache,"agentic-engineering","knowledge")
 if err=os.MkdirAll(parent,0700);err!=nil{return KnowledgePack{},err}
 folder:=fmt.Sprintf("%x",sha256.Sum256([]byte(repository+"\x00"+ref+"\x00"+manifest)))
 root:=filepath.Join(parent,folder)
 ctx,cancel:=context.WithTimeout(context.Background(),120*time.Second);defer cancel()
 if _,err=os.Stat(root);os.IsNotExist(err) {
  temp,err:=os.MkdirTemp(parent,"clone-*");if err!=nil{return KnowledgePack{},err}
  defer os.RemoveAll(temp)
  // Clone into a new child so an incomplete clone is never used as a source.
  target:=filepath.Join(temp,"repo")
  cmd:=exec.CommandContext(ctx,"git","clone","--depth=1","--branch",ref,"--quiet",repository,target)
  cmd.Env=append(os.Environ(),"GIT_TERMINAL_PROMPT=0")
  if out,err:=cmd.CombinedOutput();err!=nil{return KnowledgePack{},fmt.Errorf("GitHub sync failed (check git authentication): %s: %w",strings.TrimSpace(string(out)),err)}
  if err=os.Rename(target,root);err!=nil{return KnowledgePack{},err}
 }else if err!=nil{return KnowledgePack{},err
 }else {
  cmd:=exec.CommandContext(ctx,"git","-C",root,"fetch","--quiet","--depth=1","origin",ref)
  cmd.Env=append(os.Environ(),"GIT_TERMINAL_PROMPT=0")
  if out,err:=cmd.CombinedOutput();err!=nil{return KnowledgePack{},fmt.Errorf("GitHub fetch failed: %s: %w",strings.TrimSpace(string(out)),err)}
  cmd=exec.CommandContext(ctx,"git","-C",root,"reset","--hard","FETCH_HEAD")
  if out,err:=cmd.CombinedOutput();err!=nil{return KnowledgePack{},fmt.Errorf("cannot update managed cache: %s: %w",strings.TrimSpace(string(out)),err)}
 }
 p,err:=s.LoadLocal(root);if err!=nil{return p,err}
 p.Ref=ref
 return p,nil
}

// ReadEntry resolves an ID through the manifest, not a caller-supplied file path.
func (s *KnowledgeSource) ReadEntry(root,id string) (string,error) {
 p,err:=s.LoadLocal(root);if err!=nil{return "",err}
 for _,e:=range p.Entries {
  if e.ID!=id {continue}
  file,err:=knowledgeSafeFile(func() string {if strings.EqualFold(filepath.Ext(p.Root),".json"){return filepath.Dir(p.Root)};return p.Root}(),e.Path);if err!=nil{return "",err}
  data,err:=os.ReadFile(file);if err!=nil{return "",err}
  return string(data),nil
 }
 return "",errors.New("document ID not found")
}
