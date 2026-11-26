package main

import (
 "bytes"
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
type HarnessConsole struct { mu sync.Mutex; active map[string]context.CancelFunc }

func consoleTarget(name,path,dir string)(string,string,error){
 if name!="Claude" && name!="Codex"{return "","",errors.New("Unsupported harness")}
 if !filepath.IsAbs(dir){return "","",errors.New("Choose an absolute working directory")}
 info,err:=os.Stat(dir);if err!=nil||!info.IsDir(){return "","",errors.New("Working directory does not exist")}
 s:=agentdiscovery.Scan(name,path);if s.State!="Connected"{return "","",errors.New("Native authentication not verified")}
 return s.Path,dir,nil
}
func (h *HarnessConsole) RunPrompt(name,path,dir,prompt string) ConsoleResult {
 if strings.TrimSpace(prompt)==""||len(prompt)>32768{return ConsoleResult{Error:"Prompt is empty or too long"}}
 ctx,cancel:=context.WithTimeout(context.Background(),5*time.Minute)
 h.mu.Lock()
 if h.active==nil{h.active=make(map[string]context.CancelFunc)}
 if h.active[name]!=nil{h.mu.Unlock();cancel();return ConsoleResult{Error:"Harness already running"}}
 h.active[name]=cancel;h.mu.Unlock()
 defer func(){cancel();h.mu.Lock();delete(h.active,name);h.mu.Unlock()}()
 path,dir,err:=consoleTarget(name,path,dir);if err!=nil{return ConsoleResult{Error:err.Error()}}
 args:=[]string{"-p"}
 if name=="Codex"{args=[]string{"exec","-"}}
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
