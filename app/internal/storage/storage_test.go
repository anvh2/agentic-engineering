package storage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestOpenMigratesOnceAndSetsPragmas(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "nested", "v2.db")
	db, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	var mode string
	var fk, v int
	db.QueryRow(`PRAGMA journal_mode`).Scan(&mode)
	db.QueryRow(`PRAGMA foreign_keys`).Scan(&fk)
	db.QueryRow(`SELECT MAX(version) FROM schema_migrations`).Scan(&v)
	db.Close()
	if mode != "wal" || fk != 1 || v != LatestVersion() || v < 1 {
		t.Fatalf("mode=%s fk=%d version=%d latest=%d", mode, fk, v, LatestVersion())
	}
	if fi, err := os.Stat(path); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("database must be private: %v %v", fi.Mode(), err)
	}
	db, err = Open(ctx, path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	var rows int
	db.QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&rows)
	db.Close()
	if rows != LatestVersion() {
		t.Fatalf("migrations reapplied: %d rows", rows)
	}
	if baks, _ := filepath.Glob(path + ".v*.bak"); len(baks) != 0 {
		t.Fatalf("no snapshot expected when nothing migrates: %v", baks)
	}
}

func TestNewerSchemaIsRefused(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "v2.db")
	db, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO schema_migrations(version, name, applied_at) VALUES (999, 'future', 'x')`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if _, err := Open(ctx, path); !errors.Is(err, ErrNewerSchema) {
		t.Fatalf("want ErrNewerSchema, got %v", err)
	}
}

func TestForeignKeysEnforced(t *testing.T) {
	db, err := Open(context.Background(), filepath.Join(t.TempDir(), "v2.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO objectives(id, project_id, title, status, wake_budget, created_at, updated_at) VALUES ('o', 'missing', 't', 'active', 1, 'x', 'x')`); err == nil {
		t.Fatal("foreign key not enforced")
	}
}
