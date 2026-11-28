package main

import (
 "bytes"
 "crypto/sha256"
 "fmt"
 "github.com/wailsapp/wails/v2/pkg/runtime"
 "context"
 "errors"
 "os"
 "os/exec"
 "path/filepath"
 "strings"
 "sync"
 "time"
 "github.com/anvh2/agentic-engineering/app/internal/discovery"
)

type ConsoleResult struct { Output string `json:"output"`; Error string `json:"error"` }
type HarnessConsole struct { ctx context.Context; mu sync.Mutex; active map[string]context.CancelFunc }

func consoleTarget(name,path,dir string)(string,string,error){
 if name!="Claude" && name!="Codex"{return "","",errors.New("Unsupported harness")}
 if strings.HasPrefix(dir,"~/"){home,err:=os.UserHomeDir();if err!=nil{return "","",err};dir=filepath.Join(home,dir[2:])}
 if !filepath.IsAbs(dir){return "","",errors.New("Choose an absolute working directory")}
 info,err:=os.Stat(dir);if err!=nil||!info.IsDir(){return "","",fmt.Errorf("Working directory does not exist: %s",dir)}
 s:=discovery.Scan(name,path);if s.State!="Connected"{return "","",errors.New("Native authentication not verified")}
 return s.Path,dir,nil
}
func (h *HarnessConsole) BrowseRepository() (string,error) {if h.ctx==nil{return "",errors.New("Desktop not ready")};return runtime.OpenDirectoryDialog(h.ctx,runtime.OpenDialogOptions{Title:"Choose local repository"})}
func (h *HarnessConsole) CurrentRepository() string {
 out,err:=exec.Command("git","rev-parse","--show-toplevel").Output();if err!=nil{return ""};return strings.TrimSpace(string(out))
}
func (h *HarnessConsole) RunPrompt(name,path,dir,prompt string) ConsoleResult { return h.runPrompt(name,path,dir,prompt,"","") }
func (h *HarnessConsole) RunIssuePrompt(name,path,dir,key,prompt string) ConsoleResult { if strings.TrimSpace(dir)==""||strings.TrimSpace(key)==""{return ConsoleResult{Error:"Issue repository and key required"}};return h.runPrompt(name,path,dir,prompt,key,"") }
func (h *HarnessConsole) runPrompt(name,path,dir,prompt,key,model string) ConsoleResult {
 if strings.TrimSpace(prompt)==""||len(prompt)>262144{return ConsoleResult{Error:"Prompt is empty or too long"}}
 ctx,cancel:=context.WithTimeout(context.Background(),20*time.Minute)
 h.mu.Lock()
 if h.active==nil{h.active=make(map[string]context.CancelFunc)}
 if h.active[name]!=nil{h.mu.Unlock();cancel();return ConsoleResult{Error:"Harness already running"}}
 h.active[name]=cancel;h.mu.Unlock()
 defer func(){cancel();h.mu.Lock();delete(h.active,name);h.mu.Unlock()}()
 standalone:=strings.TrimSpace(dir)==""
 if standalone{var err error;dir,err=os.MkdirTemp("","ae-chat-");if err!=nil{return ConsoleResult{Error:err.Error()}};defer os.RemoveAll(dir)}
 path,dir,err:=consoleTarget(name,path,dir);if err!=nil{return ConsoleResult{Error:err.Error()}}
 if key!=""{
 root, e:=exec.Command("git","-C",dir,"rev-parse","--show-toplevel").Output();if e!=nil{return ConsoleResult{Error:"Issue execution requires a Git repository"}};rootDir:=strings.TrimSpace(string(root));if filepath.Clean(rootDir)!=filepath.Clean(dir){return ConsoleResult{Error:"Select the repository root"}};base:=filepath.Join(rootDir,".worktrees");if e=os.MkdirAll(base,0700);e!=nil{return ConsoleResult{Error:e.Error()}};sum:=sha256.Sum256([]byte(key));work, e:=os.MkdirTemp(base,fmt.Sprintf("issue-%x-",sum[:5]));if e!=nil{return ConsoleResult{Error:e.Error()}};if e=os.Remove(work);e!=nil{return ConsoleResult{Error:e.Error()}};if out,e:=exec.CommandContext(ctx,"git","-C",rootDir,"worktree","add","--detach",work,"HEAD").CombinedOutput();e!=nil{return ConsoleResult{Error:"Worktree creation failed: "+string(out)}};dir=work;prompt="Working in isolated worktree: "+work+"\n"+prompt
 }
 args:=[]string{"-p","--tools","Read,Grep,Glob","--output-format","stream-json","--verbose","--include-partial-messages"}
 if name=="Codex"{args=[]string{"exec","--sandbox","read-only","--json"};if standalone{args=append(args,"--skip-git-repo-check")};args=append(args,"-")}
 if key!=""{if name=="Claude"{args=[]string{"-p","--output-format","stream-json","--verbose","--include-partial-messages"}}else{args=[]string{"exec","--sandbox","workspace-write","--json","-"}}}
 if model!="" && model!="Default" {args=append([]string{args[0],"--model",model},args[1:]...)}
 cmd:=exec.CommandContext(ctx,path,args...)
 cmd.Dir=dir;cmd.Stdin=strings.NewReader(prompt)
 cmd.Env=append(os.Environ(),"PATH="+filepath.Dir(path)+":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:"+os.Getenv("PATH"))
 var stderr bytes.Buffer
 stream:=&chatStream{name:name,emit:func(kind,body string){if h.ctx!=nil{runtime.EventsEmit(h.ctx,"native-chat",map[string]string{"name":name,"kind":kind,"body":body})}}}
 cmd.Stdout=stream;cmd.Stderr=&stderr
 err=cmd.Run()
 stream.flush()
 result:=ConsoleResult{Output:stream.answer.String()};if key!=""{result.Output+="\n\nWorktree: "+dir}
 if ctx.Err()!=nil{result.Error="Prompt cancelled or timed out"}else if err!=nil{result.Error="Native CLI failed. Use interactive Terminal for diagnostics and approvals."; if diagnostic:=strings.TrimSpace(stderr.String());diagnostic!=""{if len(diagnostic)>2000{diagnostic=diagnostic[:2000]};result.Error+="\n"+diagnostic}}
 return result
}
func(h *HarnessConsole) StopPrompt(name string){h.mu.Lock();defer h.mu.Unlock();if cancel:=h.active[name];cancel!=nil{cancel()}}
func(h *HarnessConsole) stopAll(){h.mu.Lock();defer h.mu.Unlock();for _,cancel:=range h.active{cancel()}}
func(h *HarnessConsole) OpenTerminal(name,path,dir string)error{
 path,dir,err:=consoleTarget(name,path,dir);if err!=nil{return err}
 // Pass the shell command as an AppleScript argument, not interpolated source.
 quote:=func(s string)string{return "'"+strings.ReplaceAll(s,"'","'\"'\"'")+"'"}
 command:="cd "+quote(dir)+" && "+quote(path)
 return exec.Command("osascript","-e","on run argv","-e","tell application \"Terminal\" to do script (item 1 of argv)","-e","tell application \"Terminal\" to activate","-e","end run",command).Run()
}

// RunAgentContextTest reads selected documents and sends their contents to the native harness.
func(h *HarnessConsole) RunAgentContextTest(name,path,model,root string,ids []string,prompt string) ConsoleResult {
 if strings.TrimSpace(prompt)=="" {return ConsoleResult{Error:"Enter a test message"}}
 if len(ids)==0{return ConsoleResult{Error:"Select knowledge first"}}
 var b strings.Builder
 source:=&KnowledgeSource{}
 for _,id:=range ids {doc,err:=source.ReadEntry(root,id);if err!=nil{return ConsoleResult{Error:err.Error()}};fmt.Fprintf(&b,"\n--- Document: %s ---\n%s\n",id,doc)}
 b.WriteString("\n--- User message ---\n"+prompt)
 return h.runPrompt(name,path,"",b.String(),"",model)
}
