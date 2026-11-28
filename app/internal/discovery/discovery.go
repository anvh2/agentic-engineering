package discovery

import (
 "bytes"
 "context"
 "encoding/json"
 "os"
 "os/exec"
 "path/filepath"
 "strings"
 "time"
)

type Status struct {
 Name string `json:"name"`
 Path string `json:"path"`
 Version string `json:"version"`
 Authentication string `json:"authentication"`
 State string `json:"state"`
 Diagnostic string `json:"diagnostic"`
}

func candidates(name, home string) []string {
 paths := []string{}
 if p, err := exec.LookPath(name); err == nil { paths = append(paths,p) }
 for _, dir := range []string{filepath.Join(home,".local/bin"),"/opt/homebrew/bin","/usr/local/bin",filepath.Join(home,".npm-global/bin"),filepath.Join(home,".volta/bin"),filepath.Join(home,".bun/bin")} {
  paths = append(paths,filepath.Join(dir,name))
 }
 for _, pattern := range []string{filepath.Join(home,".nvm/versions/node/*/bin",name),filepath.Join(home,".fnm/node-versions/*/installation/bin",name)} {
  matches,_ := filepath.Glob(pattern)
  paths = append(paths,matches...)
 }
 return paths
}

func executable(path string) bool {
 info,err:=os.Stat(path)
 return err==nil && info.Mode().IsRegular() && info.Mode().Perm()&0111!=0
}

func probe(path string,args ...string)(string,error){
 stdout,_,err:=probeStreams(path,args...)
 return stdout,err
}

func probeStreams(path string,args ...string)(string,string,error){
 ctx,cancel:=context.WithTimeout(context.Background(),5*time.Second)
 defer cancel()
 cmd:=exec.CommandContext(ctx,path,args...)
 // Finder does not inherit the interactive shell PATH. Include the binary's
 // directory for npm-installed CLI scripts that use /usr/bin/env node.
 cmd.Env=append(os.Environ(),"PATH="+filepath.Dir(path)+":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:"+os.Getenv("PATH"))
 if home,err:=os.UserHomeDir();err==nil{cmd.Dir=home}
 var stdout,stderr bytes.Buffer
 cmd.Stdout=&stdout
 cmd.Stderr=&stderr
 err:=cmd.Run()
 return strings.TrimSpace(stdout.String()),strings.TrimSpace(stderr.String()),err
}

func Scan(name,override string) Status {
 s:=Status{Name:name,State:"Not installed",Authentication:"Unknown"}
 binary:="claude"
 if name=="Codex"{binary="codex"}else if name!="Claude"{s.State="Error";s.Diagnostic="Unsupported agent";return s}
 home,_:=os.UserHomeDir()
 paths:=candidates(binary,home)
 if override!=""{
  if strings.HasPrefix(override,"~/"){override=filepath.Join(home,override[2:])}
  if !filepath.IsAbs(override){s.State="Error";s.Diagnostic="Use an absolute executable path";return s}
  paths=[]string{override}
 }
 for _,p:=range paths{if executable(p){s.Path=p;break}}
 if s.Path==""{s.Diagnostic="Executable not found. Install the native CLI or specify its path.";return s}
 version,err:=probe(s.Path,"--version")
 if err!=nil{s.State="Error";s.Diagnostic="Version check failed or timed out";return s}
 if len(version)>200{version=version[:200]}
 s.Version=version
 s.State="Detected"
 if name=="Claude"{
  out,err:=probe(s.Path,"auth","status")
  var result struct{LoggedIn *bool `json:"loggedIn"`}
  if json.Unmarshal([]byte(out),&result)==nil && result.LoggedIn!=nil{
   if *result.LoggedIn && err==nil{s.Authentication="Authenticated";s.State="Connected"}else if !*result.LoggedIn{s.Authentication="Login required";s.State="Login required"}
  }
 }else{
  stdout,stderr,err:=probeStreams(s.Path,"login","status")
  s.Authentication,s.State=codexAuthentication(stdout,stderr,err)
 }
 if s.Authentication=="Unknown"{s.Diagnostic="Authentication could not be verified. Check native CLI login in Terminal."}
 if s.State=="Connected"{s.Diagnostic="Native login detected. MCP and execution are not verified."}
 return s
}

// Codex versions may report login status on stderr even on success.
func codexAuthentication(stdout,stderr string,err error)(string,string){
 loggedIn,loggedOut:=false,false
 for _,line:=range strings.Split(stdout+"\n"+stderr,"\n"){
  line=strings.ToLower(strings.TrimSpace(line))
  if line=="logged in" || strings.HasPrefix(line,"logged in using "){loggedIn=true}
  if line=="not logged in" || strings.HasPrefix(line,"not logged in."){loggedOut=true}
 }
 if loggedIn && !loggedOut && err==nil{return "Authenticated","Connected"}
 if loggedOut && !loggedIn{return "Login required","Login required"}
 return "Unknown","Detected"
}
