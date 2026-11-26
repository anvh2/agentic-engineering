// Package storage opens the V2 SQLite database and applies embedded,
// forward-only migrations. It holds no domain logic; internal/core issues the
// queries.
package storage

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite" // pure-Go driver: no extra cgo or system library in the DMG
)

//go:embed migrations/*.sql
var migrations embed.FS

// ErrNewerSchema means the database was written by a newer app version.
// Opening it would risk silent data loss, so it is refused.
var ErrNewerSchema = errors.New("database schema is newer than this application")

// Open opens (creating if needed) the database at path, applies pending
// migrations and returns a pool. Before migrating an existing database it
// writes a consistent snapshot next to it (VACUUM INTO, which includes WAL
// content) and keeps it.
func Open(ctx context.Context, path string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	q := url.Values{}
	q.Add("_pragma", "foreign_keys(1)")
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "busy_timeout(10000)")
	q.Add("_pragma", "synchronous(NORMAL)")
	q.Set("_txlock", "immediate") // writers take the lock at BEGIN, so CAS reads cannot go stale
	db, err := sql.Open("sqlite", "file:"+path+"?"+q.Encode())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(8)
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("open database: %w", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrate(ctx, db, path); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

type migration struct {
	version int
	name    string
	sql     string
}

func loadMigrations() ([]migration, error) {
	entries, err := fs.ReadDir(migrations, "migrations")
	if err != nil {
		return nil, err
	}
	var out []migration
	for _, e := range entries {
		n := e.Name()
		v, err := strconv.Atoi(strings.SplitN(n, "_", 2)[0])
		if err != nil {
			return nil, fmt.Errorf("migration %q: name must start with a number", n)
		}
		b, err := migrations.ReadFile("migrations/" + n)
		if err != nil {
			return nil, err
		}
		out = append(out, migration{v, n, string(b)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].version < out[j].version })
	for i, m := range out {
		if m.version != i+1 {
			return nil, fmt.Errorf("migrations must be numbered contiguously from 1; got %s", m.name)
		}
	}
	return out, nil
}

// LatestVersion is the schema version this build migrates to.
func LatestVersion() int {
	ms, err := loadMigrations()
	if err != nil {
		return 0
	}
	return len(ms)
}

func migrate(ctx context.Context, db *sql.DB, path string) error {
	ms, err := loadMigrations()
	if err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`); err != nil {
		return err
	}
	var current int
	if err := db.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&current); err != nil {
		return err
	}
	if current > len(ms) {
		return fmt.Errorf("%w: database at version %d, application knows %d", ErrNewerSchema, current, len(ms))
	}
	if current == len(ms) {
		return nil
	}
	if current > 0 {
		snap := fmt.Sprintf("%s.v%d-%s.bak", path, current, time.Now().UTC().Format("20060102T150405Z"))
		if _, err := db.ExecContext(ctx, `VACUUM INTO ?`, snap); err != nil {
			return fmt.Errorf("snapshot before migration: %w", err)
		}
	}
	for _, m := range ms[current:] {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, m.sql); err != nil {
			tx.Rollback()
			return fmt.Errorf("apply %s: %w", m.name, err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)`,
			m.version, m.name, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit %s: %w", m.name, err)
		}
	}
	return nil
}
