package main

import (
	"bytes"
	"encoding/json"
	"strings"
)

type TokenUsage struct {
	InputTokens      int64  `json:"inputTokens"`
	OutputTokens     int64  `json:"outputTokens"`
	CacheReadTokens  int64  `json:"cacheReadTokens,omitempty"`
	CacheWriteTokens int64  `json:"cacheWriteTokens,omitempty"`
	Provider         string `json:"provider"`
	Scope            string `json:"scope,omitempty"`
}

type nativeChatEvent struct {
	Type   string          `json:"type"`
	Result string          `json:"result"`
	Usage  json.RawMessage `json:"usage"`
	ModelUsage map[string]struct {
		InputTokens int64 `json:"inputTokens"`
		OutputTokens int64 `json:"outputTokens"`
		CacheReadInputTokens int64 `json:"cacheReadInputTokens"`
		CacheCreationInputTokens int64 `json:"cacheCreationInputTokens"`
	} `json:"modelUsage"`
	Event  struct {
		Type         string `json:"type"`
		Delta        struct{ Type, Text string } `json:"delta"`
		ContentBlock struct{ Type, Name string } `json:"content_block"`
	} `json:"event"`
	Item struct {
		Type string `json:"type"`
		Text string `json:"text"`
		Command string `json:"command"`
		AggregatedOutput string `json:"aggregated_output"`
		ExitCode *int `json:"exit_code"`
	} `json:"item"`
	Message struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
			Name string `json:"name"`
			Input struct { FilePath string `json:"file_path"`; Command string `json:"command"`; Pattern string `json:"pattern"` } `json:"input"`
		} `json:"content"`
	} `json:"message"`
}

// chatStream parses native JSONL without forwarding provider internals or thinking text.
// Actual usage is never confused with an estimated context-size-based token count.
type chatStream struct {
	name    string
	emit    func(string, string)
	pending bytes.Buffer
	answer  bytes.Buffer
	partial bool
	usage   *TokenUsage
}

func (s *chatStream) Write(data []byte) (int, error) {
	for _, b := range data {
		if b == '\n' {
			s.flush()
			continue
		}
		if err := s.pending.WriteByte(b); err != nil {
			return 0, err
		}
	}
	return len(data), nil
}

func (s *chatStream) text(body string) {
	if body == "" {
		return
	}
	s.answer.WriteString(body)
	if s.emit != nil {
		s.emit("text", body)
	}
}

func (s *chatStream) console(message string) {
	if s.emit != nil && message != "" {
		if len(message) > 4096 { message = message[:4096] + " …" }
		s.emit("console", message)
	}
}

func (s *chatStream) activity(message string) {
	s.console(message)
	if s.emit != nil {
		s.emit("activity", message)
	}
}

func (s *chatStream) recordUsage(event nativeChatEvent) {
	// Claude result.modelUsage contains invocation-wide totals across models.
	// result.usage alone may cover only the final model call.
	if s.name == "Claude" && event.Type == "result" && len(event.ModelUsage) > 0 {
		aggregate := &TokenUsage{Provider: "Claude", Scope: "invocation"}
		for _, model := range event.ModelUsage {
			aggregate.InputTokens += model.InputTokens
			aggregate.OutputTokens += model.OutputTokens
			aggregate.CacheReadTokens += model.CacheReadInputTokens
			aggregate.CacheWriteTokens += model.CacheCreationInputTokens
		}
		s.usage = aggregate
		return
	}
	if !(s.name == "Claude" && event.Type == "result") &&
		!(s.name == "Codex" && event.Type == "turn.completed") {
		return
	}
	if len(event.Usage) == 0 || string(event.Usage) == "null" {
		return
	}
	var usage struct {
		InputTokens              int64 `json:"input_tokens"`
		OutputTokens             int64 `json:"output_tokens"`
		CachedInputTokens        int64 `json:"cached_input_tokens"`
		CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
		CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
	}
	if err := json.Unmarshal(event.Usage, &usage); err != nil {
		return
	}
	cacheRead := usage.CachedInputTokens
	if s.name == "Claude" {
		cacheRead = usage.CacheReadInputTokens
	}
	s.usage = &TokenUsage{
		Provider:         s.name,
		Scope:            map[bool]string{true: "result", false: "turn"}[s.name == "Claude"],
		InputTokens:      usage.InputTokens,
		OutputTokens:     usage.OutputTokens,
		CacheReadTokens:  cacheRead,
		CacheWriteTokens: usage.CacheCreationInputTokens,
	}
}

func (s *chatStream) readClaudeEvent(event nativeChatEvent) {
	switch event.Type {
	case "system":
		s.activity("Claude session initialized")
	case "stream_event":
		if event.Event.Type == "message_start" {
			s.activity("Receiving Claude response")
		}
		if event.Event.ContentBlock.Type == "thinking" || event.Event.Delta.Type == "thinking_delta" {
			s.activity("Thinking…")
		}
		if event.Event.Delta.Type == "text_delta" {
			s.partial = true
			s.text(event.Event.Delta.Text)
		}
		if event.Event.ContentBlock.Type == "tool_use" {
			s.activity("Using " + event.Event.ContentBlock.Name)
		}
	case "assistant":
		for _, block := range event.Message.Content {
			if block.Type == "tool_use" {
				s.console(block.Name + " " + strings.TrimSpace(block.Input.FilePath + " " + block.Input.Command + " " + block.Input.Pattern))
			}
		}
		if !s.partial {
			for _, block := range event.Message.Content {
				if block.Type == "text" {
					s.text(block.Text)
				} else if block.Type == "tool_use" {
					s.activity("Using " + block.Name)
				}
			}
		}
		s.partial = false
	case "result":
		if s.answer.Len() == 0 {
			s.text(event.Result)
		}
	}
}

func (s *chatStream) readCodexEvent(event nativeChatEvent) {
	if event.Item.Type == "command_execution" {
		if event.Type == "item.started" { s.console("$ " + event.Item.Command) }
		if event.Type == "item.completed" { s.console(event.Item.AggregatedOutput) }
	}
	if event.Type == "item.completed" && event.Item.Type == "agent_message" {
		if s.answer.Len() > 0 {
			s.text("\n\n")
		}
		s.text(event.Item.Text)
	}
	if event.Type == "thread.started" {
		s.activity("Codex session initialized")
	}
	if event.Type == "turn.started" {
		s.activity("Codex turn started")
	}
	if strings.HasPrefix(event.Type, "item.") &&
		event.Item.Type != "" && event.Item.Type != "agent_message" {
		s.activity(strings.ReplaceAll(event.Item.Type, "_", " "))
	}
}

func (s *chatStream) flush() {
	if s.pending.Len() == 0 {
		return
	}
	var event nativeChatEvent
	err := json.Unmarshal(s.pending.Bytes(), &event)
	s.pending.Reset()
	if err != nil {
		return
	}
	s.recordUsage(event)
	if s.name == "Claude" {
		s.readClaudeEvent(event)
		return
	}
	s.readCodexEvent(event)
}
