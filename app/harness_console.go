package main

import (
 "bytes"
 "github.com/wailsapp/wails/v2/pkg/runtime"
 "context"
 "errors"
 "os"
 "os/exec"
 "path/filepath"
 "strings"
 "sync"
 "time"
 "github.com/anvh2/agentic-engineering/app/internal/agentdiscovery"
)

type ConsoleResult struct { Output string `json:"output"`; Error string `json:"error"` }
type HarnessConsole struct { ctx context.Context; mu sync.Mutex; active map[string]context.CancelFunc }

func consoleTarget(name,path,dir string)(string,string,error){
 if name!="Claude" && name!="Codex"{return "","",errors.New("Unsupported harness")}
 if strings.HasPrefix(dir,"~/"){home,err:=os.UserHomeDir();if err!=nil{return "","",err};dir=filepath.Join(home,dir[2:])}
 if !filepath.IsAbs(dir){return "","",errors.New("Choose an absolute working directory")}
 info,err:=os.Stat(dir);if err!=nil||!info.IsDir(){return "","",errors.New("Working directory does not exist")}
 s:=agentdiscovery.Scan(name,path);if s.State!="Connected"{return "","",errors.New("Native authentication not verified")}
 return s.Path,dir,nil
}
func (h *HarnessConsole) BrowseRepository() (string,error) {if h.ctx==nil{return "",errors.New("Desktop not ready")};return runtime.OpenDirectoryDialog(h.ctx,runtime.OpenDialogOptions{Title:"Choose local repository"})}
func (h *HarnessConsole) CurrentRepository() string {
 out,err:=exec.Command("git","rev-parse","--show-toplevel").Output();if err!=nil{return ""};return strings.TrimSpace(string(out))
}
func (h *HarnessConsole) RunPrompt(name,path,dir,prompt string) ConsoleResult {
 if strings.TrimSpace(prompt)==""||len(prompt)>32768{return ConsoleResult{Error:"Prompt is empty or too long"}}
 ctx,cancel:=context.WithTimeout(context.Background(),20*time.Minute)
 h.mu.Lock()
 if h.active==nil{h.active=make(map[string]context.CancelFunc)}
 if h.active[name]!=nil{h.mu.Unlock();cancel();return ConsoleResult{Error:"Harness already running"}}
 h.active[name]=cancel;h.mu.Unlock()
 defer func(){cancel();h.mu.Lock();delete(h.active,name);h.mu.Unlock()}()
 if strings.TrimSpace(dir)==""{var err error;dir,err=os.UserHomeDir();if err!=nil{return ConsoleResult{Error:err.Error()}}}
 path,dir,err:=consoleTarget(name,path,dir);if err!=nil{return ConsoleResult{Error:err.Error()}}
 args:=[]string{"-p","--tools","Read,Grep,Glob"}
 if name=="Codex"{args=[]string{"exec","--sandbox","read-only","-"}}
 cmd:=exec.CommandContext(ctx,path,args...)
 cmd.Dir=dir;cmd.Stdin=strings.NewReader(prompt)
 cmd.Env=append(os.Environ(),"PATH="+filepath.Dir(path)+":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:"+os.Getenv("PATH"))
 var stdout,stderr bytes.Buffer
 cmd.Stdout=&stdout;cmd.Stderr=&stderr
 err=cmd.Run()
 result:=ConsoleResult{Output:stdout.String()}
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
