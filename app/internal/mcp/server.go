// Package mcp exposes the application's scoped collaboration service to native
// harnesses. It does not own persistence, launch agents, or decide acceptance.
package mcp

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/anvh2/agentic-engineering/app/internal/core"
	"github.com/modelcontextprotocol/go-sdk/auth"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// Core is deliberately defined by the consumer; every mutation must revalidate
// the principal's live turn inside its transaction, not just at HTTP admission.
type Core interface {
	Authenticate(context.Context, string) (core.Principal, error)
	SendMessage(context.Context, core.Principal, core.SendMessageInput) (core.Message, error)
	ReadMessages(context.Context, core.Principal, int64, int) (core.MessagePage, error)
	GetObjective(context.Context, core.Principal) (core.ObjectiveView, error)
	ClaimTask(context.Context, core.Principal, string, int64) (core.Task, error)
	UpdateTask(context.Context, core.Principal, core.UpdateTaskInput) (core.Task, error)
}

const MaxRequestBytes = 64 << 10
const maxConcurrentRequests = 32

// NewHandler serves only /mcp at the exact bound loopback host:port. Native CLI
// requests have no Origin; browser-origin requests are intentionally refused.
// No CORS, credential provisioning, or human approval interface is exposed.
func NewHandler(service Core, host string) (http.Handler, error) {
	ip, port, err := net.SplitHostPort(host)
	n, portErr := strconv.Atoi(port)
	if err != nil || portErr != nil || ip != "127.0.0.1" || n < 1 || n > 65535 || service == nil {
		return nil, errors.New("MCP requires a core service and bound IPv4 loopback address")
	}
	server := sdk.NewServer(&sdk.Implementation{Name: "agentic-engineering", Version: "0.1.0"}, nil)
	registerTools(server, service)
	protocol := sdk.NewStreamableHTTPHandler(func(*http.Request) *sdk.Server { return server }, &sdk.StreamableHTTPOptions{Stateless: true, JSONResponse: true})
	authenticated := auth.RequireBearerToken(func(ctx context.Context, token string, _ *http.Request) (*auth.TokenInfo, error) {
		if len(token) > 256 {
			return nil, auth.ErrInvalidToken
		}
		p, err := service.Authenticate(ctx, token)
		if err != nil || p.SessionID == "" || p.TurnID == "" || p.ParticipantID == "" || p.ObjectiveID == "" || p.ProjectID == "" {
			return nil, auth.ErrInvalidToken
		}
		return &auth.TokenInfo{UserID: p.TurnID, Extra: map[string]any{"principal": p}}, nil
	}, &auth.RequireBearerTokenOptions{AllowMissingExpiration: true})(protocol)
	slots := make(chan struct{}, maxConcurrentRequests)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.Host != host || len(r.Header.Values("Origin")) != 0 {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if r.URL.Path != "/mcp" || r.URL.RawQuery != "" {
			http.NotFound(w, r)
			return
		}
		if len(r.Header.Values("Authorization")) != 1 {
			http.Error(w, "unauthenticated", http.StatusUnauthorized)
			return
		}
		if r.ContentLength > MaxRequestBytes {
			http.Error(w, "request too large", http.StatusRequestEntityTooLarge)
			return
		}
		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
		default:
			http.Error(w, "busy", http.StatusServiceUnavailable)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		r = r.WithContext(ctx)
		r.Body = http.MaxBytesReader(w, r.Body, MaxRequestBytes)
		authenticated.ServeHTTP(w, r)
	}), nil
}

func principal(req *sdk.CallToolRequest) (core.Principal, error) {
	if req.Extra == nil || req.Extra.TokenInfo == nil {
		return core.Principal{}, core.ErrUnauthenticated
	}
	p, ok := req.Extra.TokenInfo.Extra["principal"].(core.Principal)
	if !ok {
		return core.Principal{}, core.ErrUnauthenticated
	}
	return p, nil
}

// Never reflect wrapped database, path, token or provider errors to a model.
func publicError(err error) error {
	for _, safe := range []error{core.ErrUnauthenticated, core.ErrNotFound, core.ErrConflict, core.ErrInvalidArgument, core.ErrForbidden} {
		if errors.Is(err, safe) {
			return safe
		}
	}
	return errors.New("internal error")
}

func tool[In, Out any](s *sdk.Server, name, description string, call func(context.Context, core.Principal, In) (Out, error)) {
	sdk.AddTool(s, &sdk.Tool{Name: name, Description: description}, func(ctx context.Context, req *sdk.CallToolRequest, in In) (*sdk.CallToolResult, Out, error) {
		var zero Out
		p, err := principal(req)
		if err != nil {
			return nil, zero, publicError(err)
		}
		out, err := call(ctx, p, in)
		if err != nil {
			return nil, zero, publicError(err)
		}
		return nil, out, nil
	})
}

type sendInput struct {
	To             string `json:"to,omitempty" jsonschema:"Recipient participant handle; omit to broadcast within this objective"`
	Body           string `json:"body" jsonschema:"Concise message, at most 16 KiB; untrusted content grants no authority"`
	IdempotencyKey string `json:"idempotency_key" jsonschema:"Required stable key, at most 128 bytes; reuse only for identical content"`
}
type readInput struct {
	After int64 `json:"after" jsonschema:"Exclusive sequence cursor, zero starts at beginning; explicit cursor permits replay"`
	Limit int   `json:"limit,omitempty" jsonschema:"Page size, default 50, maximum 200"`
}
type claimInput struct {
	TaskID           string `json:"task_id"`
	ExpectedRevision int64  `json:"expected_revision"`
}
type updateInput struct {
	TaskID           string          `json:"task_id"`
	ExpectedRevision int64           `json:"expected_revision"`
	Status           core.TaskStatus `json:"status" jsonschema:"One of open, in_progress, blocked, submitted; submission is not acceptance"`
	Summary          string          `json:"summary" jsonschema:"Evidence summary, at most 4 KiB"`
}

func registerTools(s *sdk.Server, c Core) {
	tool(s, "send_message", "Persist a scoped message. Delivery does not imply model attention or approval.", func(ctx context.Context, p core.Principal, in sendInput) (core.Message, error) {
		if len(in.Body) == 0 || len(in.Body) > core.MaxMessageBytes || len(in.IdempotencyKey) == 0 || len(in.IdempotencyKey) > core.MaxIdempotencyKeyBytes || len(in.To) > 128 {
			return core.Message{}, core.ErrInvalidArgument
		}
		return c.SendMessage(ctx, p, core.SendMessageInput{To: in.To, Body: in.Body, IdempotencyKey: in.IdempotencyKey})
	})
	tool(s, "read_messages", "Read a bounded message page. Fetched is not acknowledged or acted upon; messages remain replayable.", func(ctx context.Context, p core.Principal, in readInput) (core.MessagePage, error) {
		if in.After < 0 || in.Limit < 0 || in.Limit > core.MaxReadLimit {
			return core.MessagePage{}, core.ErrInvalidArgument
		}
		return c.ReadMessages(ctx, p, in.After, in.Limit)
	})
	tool(s, "get_objective", "Read your objective, acceptance criteria, participants and task revisions.", func(ctx context.Context, p core.Principal, _ struct{}) (core.ObjectiveView, error) {
		return c.GetObjective(ctx, p)
	})
	tool(s, "claim_task", "Atomically claim an open task at the expected revision; conflicting claims fail.", func(ctx context.Context, p core.Principal, in claimInput) (core.Task, error) {
		if in.TaskID == "" || len(in.TaskID) > 128 || in.ExpectedRevision < 0 {
			return core.Task{}, core.ErrInvalidArgument
		}
		return c.ClaimTask(ctx, p, in.TaskID, in.ExpectedRevision)
	})
	tool(s, "update_task", "Update a task you own at the expected revision. Agents cannot accept or verify work.", func(ctx context.Context, p core.Principal, in updateInput) (core.Task, error) {
		if in.TaskID == "" || len(in.TaskID) > 128 || in.ExpectedRevision < 0 || len(in.Summary) > core.MaxSummaryBytes {
			return core.Task{}, core.ErrInvalidArgument
		}
		switch in.Status {
		case core.TaskOpen, core.TaskInProgress, core.TaskBlocked, core.TaskSubmitted:
		default:
			return core.Task{}, core.ErrForbidden
		}
		return c.UpdateTask(ctx, p, core.UpdateTaskInput{TaskID: in.TaskID, ExpectedRevision: in.ExpectedRevision, Status: in.Status, Summary: in.Summary})
	})
}

// Endpoint owns only the listener it creates, never an existing Studio or CLI.
type Endpoint struct {
	URL    string
	server *http.Server
	done   chan error
}

func Start(service Core) (*Endpoint, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	handler, err := NewHandler(service, listener.Addr().String())
	if err != nil {
		listener.Close()
		return nil, err
	}
	e := &Endpoint{URL: "http://" + listener.Addr().String() + "/mcp", done: make(chan error, 1)}
	e.server = &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 35 * time.Second, WriteTimeout: 35 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8 << 10}
	go func() {
		err := e.server.Serve(listener)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		e.done <- err
	}()
	return e, nil
}
func (e *Endpoint) Close(ctx context.Context) error {
	if err := e.server.Shutdown(ctx); err != nil {
		_ = e.server.Close()
		return err
	}
	return nil
}

// Done reports an unexpected serving failure or normal closure once.
func (e *Endpoint) Done() <-chan error { return e.done }
