package main

import (
 "bytes"
 "encoding/json"
 "strings"
)

type chatStream struct {
 name string
 emit func(string,string)
 pending, answer bytes.Buffer
 partial bool
}
func(s *chatStream) Write(p []byte)(int,error){
 for _,b:=range p{if b=='\n'{s.flush()}else{s.pending.WriteByte(b)}}
 return len(p),nil
}
func(s *chatStream) flush(){
 if s.pending.Len()==0{return}
 var e struct{
 Type string
 Result string
 Event struct{Type string; Delta struct{Type,Text string}; ContentBlock struct{Type,Name string} `json:"content_block"`}
 Item struct{Type,Text string}
 Message struct{Content []struct{Type,Text,Name string}}
 }
 err:=json.Unmarshal(s.pending.Bytes(),&e);s.pending.Reset();if err!=nil{return}
 add:=func(t string){if t!=""{s.answer.WriteString(t);s.emit("text",t)}}
 if s.name=="Claude"{
 switch e.Type{
 case "stream_event":
 if e.Event.Delta.Type=="text_delta"{s.partial=true;add(e.Event.Delta.Text)}
 if e.Event.ContentBlock.Type=="tool_use"{s.emit("activity","Using "+e.Event.ContentBlock.Name)}
 case "assistant":
 if !s.partial{for _,b:=range e.Message.Content{if b.Type=="text"{add(b.Text)}else if b.Type=="tool_use"{s.emit("activity","Using "+b.Name)}}};s.partial=false
 case "result":if s.answer.Len()==0{add(e.Result)}
 }
 }else{
 if e.Type=="item.completed"&&e.Item.Type=="agent_message"{if s.answer.Len()>0{add("\n\n")};add(e.Item.Text)}
 if strings.HasPrefix(e.Type,"item.")&&e.Item.Type!="agent_message"{s.emit("activity",strings.ReplaceAll(e.Item.Type,"_"," "))}
 }
}
