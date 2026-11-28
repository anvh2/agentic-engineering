package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/anvh2/agentic-engineering/app/internal/agent"
	"github.com/anvh2/agentic-engineering/app/internal/core"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type fakeCore struct {
	mu      sync.Mutex
	revoked bool
	err     error
	last    core.Principal
	calls   int
}

func (f *fakeCore) Authenticate(_ context.Context, token string) (core.Principal, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.revoked || (token != "alpha" && token != "beta") {
		return core.Principal{}, errors.New("secret token database path")
	}
	return core.Principal{SessionID: token, TurnID: token + "-turn", ParticipantID: token, ProjectID: token + "-project", ObjectiveID: token + "-objective", Handle: token}, nil
}
func (f *fakeCore) record(p core.Principal) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.last = p
	f.calls++
	if f.revoked {
		return core.ErrUnauthenticated
	}
	return f.err
}
func (f *fakeCore) SendMessage(_ context.Context, p core.Principal, in core.SendMessageInput) (core.Message, error) {
	return core.Message{From: p.Handle, Body: in.Body, ObjectiveID: p.ObjectiveID}, f.record(p)
}
func (f *fakeCore) ReadMessages(_ context.Context, p core.Principal, after int64, limit int) (core.MessagePage, error) {
	return core.MessagePage{Messages: []core.Message{}, NextAfter: after}, f.record(p)
}
func (f *fakeCore) GetObjective(_ context.Context, p core.Principal) (core.ObjectiveView, error) {
	return core.ObjectiveView{ID: p.ObjectiveID}, f.record(p)
}
func (f *fakeCore) ClaimTask(_ context.Context, p core.Principal, id string, rev int64) (core.Task, error) {
	return core.Task{ID: id, Owner: p.Handle, Revision: rev + 1}, f.record(p)
}
func (f *fakeCore) UpdateTask(_ context.Context, p core.Principal, in core.UpdateTaskInput) (core.Task, error) {
	return core.Task{ID: in.TaskID, Status: in.Status, Revision: in.ExpectedRevision + 1}, f.record(p)
}
func (f *fakeCore) SubmitReview(_ context.Context, p core.Principal, in core.SubmitReviewInput) (core.Review, error) {
	return core.Review{ObjectiveID: p.ObjectiveID, Verdict: in.Verdict}, f.record(p)
}
func handler(t *testing.T, f *fakeCore) http.Handler {
	t.Helper()
	h, err := NewHandler(f, "127.0.0.1:43999")
	if err != nil {
		t.Fatal(err)
	}
	return h
}
func rpc(t *testing.T, h http.Handler, token, method string, params any) *httptest.ResponseRecorder {
	t.Helper()
	b, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", "http://127.0.0.1:43999/mcp", strings.NewReader(string(b)))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Accept", "application/json, text/event-stream")
	r.Header.Set("MCP-Protocol-Version", "2025-06-18")
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}
func call(t *testing.T, h http.Handler, token, name string, args any) *httptest.ResponseRecorder {
	return rpc(t, h, token, "tools/call", map[string]any{"name": name, "arguments": args})
}
func TestProtocolAndPrincipal(t *testing.T) {
	f := &fakeCore{}
	h := handler(t, f)
	init := rpc(t, h, "alpha", "initialize", map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "test", "version": "1"}})
	if init.Code != 200 || !strings.Contains(init.Body.String(), "agentic-engineering") {
		t.Fatalf("init %d %s", init.Code, init.Body)
	}
	list := rpc(t, h, "alpha", "tools/list", map[string]any{})
	var listed struct {
		Result struct {
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal(list.Body.Bytes(), &listed); err != nil || len(listed.Result.Tools) != len(agent.CollaborationTools) {
		t.Fatalf("tools %s %v", list.Body, err)
	}
	for _, token := range []string{"alpha", "beta"} {
		w := call(t, h, token, "send_message", map[string]any{"body": "hello", "idempotency_key": "k"})
		if w.Code != 200 || !strings.Contains(w.Body.String(), token+"-objective") {
			t.Fatalf("call %d %s", w.Code, w.Body)
		}
		if f.last.SessionID != token {
			t.Fatal("principal crossed requests")
		}
	}
}
func TestRejectsForgedIdentityAndInvalidArguments(t *testing.T) {
	for _, tc := range []struct {
		name string
		args map[string]any
	}{
		{"get_objective", map[string]any{"project_id": "foreign"}},
		{"send_message", map[string]any{"body": "x", "idempotency_key": "k", "author": "human"}},
		{"send_message", map[string]any{"body": strings.Repeat("x", core.MaxMessageBytes+1), "idempotency_key": "k"}},
		{"read_messages", map[string]any{"after": -1}},
		{"read_messages", map[string]any{"after": 0, "limit": 201}},
		{"claim_task", map[string]any{"task_id": "x", "expected_revision": -1}},
		{"update_task", map[string]any{"task_id": "x", "expected_revision": 1, "status": "accepted", "summary": "trust me"}},
		{"submit_review", map[string]any{"verdict": "accepted", "summary": "x", "verification": "y"}},
		{"submit_review", map[string]any{"verdict": "approved", "summary": "x"}},
	} {
		t.Run(tc.name+fmt.Sprint(len(tc.args)), func(t *testing.T) {
			f := &fakeCore{}
			w := call(t, handler(t, f), "alpha", tc.name, tc.args)
			if f.calls != 0 {
				t.Fatalf("invalid arguments reached core: %s", w.Body)
			}
			if !strings.Contains(w.Body.String(), "error") && !strings.Contains(w.Body.String(), "isError") {
				t.Fatalf("not rejected %s", w.Body)
			}
		})
	}
}
func TestHTTPBoundary(t *testing.T) {
	f := &fakeCore{}
	h := handler(t, f)
	for _, tc := range []struct {
		name, host, origin, token, path string
		size                            int
		want                            int
	}{
		{name: "no token", host: "127.0.0.1:43999", path: "/mcp", want: 401},
		{name: "bad token", host: "127.0.0.1:43999", token: "invalid", path: "/mcp", want: 401},
		{name: "foreign host", host: "attacker.test:43999", token: "alpha", path: "/mcp", want: 403},
		{name: "foreign origin", host: "127.0.0.1:43999", origin: "https://attacker.test", token: "alpha", path: "/mcp", want: 403},
		{name: "null origin", host: "127.0.0.1:43999", origin: "null", token: "alpha", path: "/mcp", want: 403},
		{name: "query", host: "127.0.0.1:43999", token: "alpha", path: "/mcp?token=x", want: 404},
		{name: "oversize", host: "127.0.0.1:43999", token: "alpha", path: "/mcp", size: MaxRequestBytes + 1, want: 413},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "http://"+tc.host+tc.path, strings.NewReader(strings.Repeat("x", tc.size)))
			if tc.token != "" {
				r.Header.Set("Authorization", "Bearer "+tc.token)
			}
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d %s", w.Code, tc.want, w.Body)
			}
			if strings.Contains(w.Body.String(), "secret") {
				t.Fatal("internal error leaked")
			}
		})
	}
	if f.calls != 0 {
		t.Fatal("unauthorized request reached core")
	}
}
func TestErrorsRedactedAndRevocationRechecked(t *testing.T) {
	f := &fakeCore{}
	h := handler(t, f)
	for _, err := range []error{errors.New("secret /private/database.db"), fmt.Errorf("%w: secret", core.ErrConflict)} {
		f.err = err
		w := call(t, h, "alpha", "get_objective", map[string]any{})
		if strings.Contains(w.Body.String(), "secret") || !strings.Contains(w.Body.String(), "isError") {
			t.Fatalf("unsafe error %s", w.Body)
		}
	}
	f.revoked = true
	w := call(t, h, "alpha", "get_objective", map[string]any{})
	if w.Code != 401 {
		t.Fatalf("revoked %d", w.Code)
	}
}

type localTransport struct {
	h     http.Handler
	token string
}

func (tr localTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+tr.token)
	w := httptest.NewRecorder()
	tr.h.ServeHTTP(w, r)
	return w.Result(), nil
}
func TestOfficialSDKClient(t *testing.T) {
	f := &fakeCore{}
	h := handler(t, f)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client := sdk.NewClient(&sdk.Implementation{Name: "native-protocol-test", Version: "1"}, nil)
	session, err := client.Connect(ctx, &sdk.StreamableClientTransport{Endpoint: "http://127.0.0.1:43999/mcp", HTTPClient: &http.Client{Transport: localTransport{h, "alpha"}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	listed, err := session.ListTools(ctx, nil)
	if err != nil || len(listed.Tools) != len(agent.CollaborationTools) {
		t.Fatalf("list %v %v", listed, err)
	}
	result, err := session.CallTool(ctx, &sdk.CallToolParams{Name: "get_objective", Arguments: map[string]any{}})
	if err != nil || result.IsError {
		t.Fatalf("call %v %v", result, err)
	}
}
func TestConcurrentPrincipals(t *testing.T) {
	f := &fakeCore{}
	h := handler(t, f)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			token := "alpha"
			if i%2 == 0 {
				token = "beta"
			}
			w := call(t, h, token, "get_objective", map[string]any{})
			if !strings.Contains(w.Body.String(), token+"-objective") {
				t.Errorf("scope mixed: %s", w.Body)
			}
		}(i)
	}
	wg.Wait()
}
