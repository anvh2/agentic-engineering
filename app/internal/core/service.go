package core

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base32"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

// Service is the V2 domain service. It is safe for concurrent use; write
// transactions take SQLite's write lock at BEGIN (see storage.Open), so
// compare-and-swap checks inside a transaction cannot race.
type Service struct {
	db        *sql.DB
	now       func() time.Time
	onMessage func(objectiveID string) // set by the wake coordinator; must not block
}

// New returns a Service over an opened, migrated database.
func New(db *sql.DB) *Service {
	return &Service{db: db, now: func() time.Time { return time.Now().UTC() }}
}

// SetClock replaces the clock; tests only.
func (s *Service) SetClock(now func() time.Time) { s.now = now }

var idEncoding = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").WithPadding(base32.NoPadding)

func newID(prefix string) string {
	b := make([]byte, 10)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("crypto/rand: %v", err))
	}
	return prefix + "_" + idEncoding.EncodeToString(b)
}

func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func (s *Service) ts() string { return s.now().Format(time.RFC3339Nano) }

func parseTS(v string) time.Time {
	t, _ := time.Parse(time.RFC3339Nano, v)
	return t
}

type timeScanner struct{ t *time.Time }

func (ts timeScanner) Scan(v any) error {
	switch x := v.(type) {
	case string:
		*ts.t = parseTS(x)
	case []byte:
		*ts.t = parseTS(string(x))
	case nil:
		*ts.t = time.Time{}
	default:
		return fmt.Errorf("unsupported time value %T", v)
	}
	return nil
}

func scanTime(t *time.Time) timeScanner { return timeScanner{t} }

// SetMessageNotifier installs a nonblocking callback before serving MCP or\n// starting native turns. The notifier must not be replaced while running.\nfunc (s *Service) SetMessageNotifier(notify func(objectiveID string)) {\n\ts.onMessage = notify\n}\n\n// notifyMessage tells the wake coordinator, if any, that an objective has new
// mail. It never blocks the caller.
func (s *Service) notifyMessage(objectiveID string) {
	if f := s.onMessage; f != nil {
		f(objectiveID)
	}
}

func (s *Service) tx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidArgument, fmt.Sprintf(format, a...))
}

func conflict(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrConflict, fmt.Sprintf(format, a...))
}

// Reserved handles that are never participants.
const (
	HandleHuman  = "human"
	HandleSystem = "system"
)

// handleFor derives a participant handle such as "codex-developer".
func handleFor(agent, role string) string {
	r := strings.ToLower(strings.TrimSpace(role))
	r = strings.Map(func(c rune) rune {
		switch {
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9':
			return c
		default:
			return '-'
		}
	}, r)
	return agent + "-" + strings.Trim(r, "-")
}
