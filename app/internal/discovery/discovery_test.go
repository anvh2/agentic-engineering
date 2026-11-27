package discovery
import ("testing"; "errors"; "os"; "path/filepath")
func TestUnsupportedAgent(t *testing.T){if s:=Scan("unknown","");s.State!="Error"{t.Fatalf("unexpected status: %+v",s)}}
func TestRelativeOverride(t *testing.T){if s:=Scan("Claude","relative/claude");s.State!="Error"{t.Fatalf("unexpected status: %+v",s)}}
func TestMissingOverride(t *testing.T){if s:=Scan("Codex","/nonexistent/agentic-engineering-test/codex");s.State!="Not installed"{t.Fatalf("unexpected status: %+v",s)}}

func TestCodexAuthentication(t *testing.T){
 for _,tc:=range []struct{name,stdout,stderr,want string;err error}{
 {"stdout","Logged in using ChatGPT","","Connected",nil},
 {"stderr","","Logged in using ChatGPT","Connected",nil},
 {"warning","warning","Logged in using ChatGPT","Connected",nil},
 {"failed","","Logged in using ChatGPT","Detected",errors.New("failed")},
 {"logged out","","Not logged in","Login required",errors.New("exit 1")},
 {"unknown","","unexpected","Detected",nil},
 {"conflict","Not logged in","Logged in using ChatGPT","Detected",nil},
 }{t.Run(tc.name,func(t *testing.T){_,got:=codexAuthentication(tc.stdout,tc.stderr,tc.err);if got!=tc.want{t.Fatalf("got %s want %s",got,tc.want)}})}
}
func TestScanCodexStderr(t *testing.T){
 path:=filepath.Join(t.TempDir(),"codex")
 script:="#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'codex-cli 0.161.0'; else echo 'Logged in using ChatGPT' >&2; fi\n"
 if err:=os.WriteFile(path,[]byte(script),0700);err!=nil{t.Fatal(err)}
 if s:=Scan("Codex",path);s.State!="Connected"||s.Version!="codex-cli 0.161.0"{t.Fatalf("unexpected status: %+v",s)}
}
