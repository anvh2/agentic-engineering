package main

import (
	"bytes"
	"encoding/json"
	"strings"
)

type TokenUsage struct {
	InputTokens int64 `json:"inputTokens"`
	OutputTokens int64 `json:"outputTokens"`
	CacheReadTokens int64 `json:"cacheReadTokens,omitempty"`
	CacheWriteTokens int64 `json:"cacheWriteTokens,omitempty"`
	Provider string `json:"provider"`
}

// chatStream records only telemetry the native harness actually reports.
// The context estimate (bytes/4) is tracked separately by the knowledge runner.
type chatStream struct {
	name string
	emit func(string,string)
	pending,answer bytes.Buffer
	partial bool
	usage *TokenUsage
}
func(s *chatStream) Write(p []byte)(int,error){
	for _,b:=range p{if b=='\n'{s.flush()}else{s.pending.WriteByte(b)}}
	return len(p),nil
}
func(s *chatStream) flush(){
	if s.pending.Len()==0{return}
	var e struct{
		Type string `json:"type"`
		Result string `json:"result"`
		Usage json.RawMessage `json:"usage"`
		Event struct{Type string `json:"type"`;Delta struct{Type,Text string};ContentBlock struct{Type,Name string} `json:"content_block"`} `json:"event"`
		Item struct{Type,Text string} `json:"item"`
		Message struct{Content []struct{Type,Text,Name string}} `json:"message"`
	}
	err:=json.Unmarshal(s.pending.Bytes(),&e);s.pending.Reset();if err!=nil{return}
	add:=func(t string){if t!=""{s.answer.WriteString(t);if s.emit!=nil{s.emit("text",t)}}}
	activity:=func(t string){if s.emit!=nil{s.emit("activity",t)}}
	// Claude result.usage and Codex turn.completed.usage share token names,
	// but only Claude provides cache creation and cache read subcategories.
	if (s.name=="Claude"&&e.Type=="result") || (s.name=="Codex"&&e.Type=="turn.completed") {
		if len(e.Usage)>0 && string(e.Usage)!="null" {
			var u struct {
				InputTokens int64 `json:"input_tokens"`
				OutputTokens int64 `json:"output_tokens"`
				CachedInputTokens int64 `json:"cached_input_tokens"`
				CacheReadInputTokens int64 `json:"cache_read_input_tokens"`
				CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
			}
			if json.Unmarshal(e.Usage,&u)==nil{
				cacheRead:=u.CachedInputTokens
				if s.name=="Claude"{cacheRead=u.CacheReadInputTokens}
				s.usage=&TokenUsage{InputTokens:u.InputTokens,OutputTokens:u.OutputTokens,CacheReadTokens:cacheRead,CacheWriteTokens:u.CacheCreationInputTokens,Provider:s.name}
			}
		}
	}
	if s.name=="Claude"{
		switch e.Type{
		case "system":activity("Claude session initialized")
		case "stream_event":
			if e.Event.Type=="message_start"{activity("Receiving Claude response")}
			if e.Event.ContentBlock.Type=="thinking"||e.Event.Delta.Type=="thinking_delta"{activity("Thinking…")}
			if e.Event.Delta.Type=="text_delta"{s.partial=true;add(e.Event.Delta.Text)}
			if e.Event.ContentBlock.Type=="tool_use"{activity("Using "+e.Event.ContentBlock.Name)}
		case "assistant":
			if !s.partial{for _,b:=range e.Message.Content{if b.Type=="text"{add(b.Text)}else if b.Type=="tool_use"{activity("Using "+b.Name)}}};s.partial=false
		case "result":
			if s.answer.Len()==0{add(e.Result)}
		}
	}else{
		if e.Type=="item.completed"&&e.Item.Type=="agent_message"{if s.answer.Len()>0{add("\n\n")};add(e.Item.Text)}
		if e.Type=="thread.started"{activity("Codex session initialized")}
		if e.Type=="turn.started"{activity("Codex turn started")}
		if strings.HasPrefix(e.Type,"item.")&&e.Item.Type!=""&&e.Item.Type!="agent_message"{activity(strings.ReplaceAll(e.Item.Type,"_"," "))}
	}
}
