package localdocker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// migrate runs data.migrate on the host, in the checkout.
func (d *Driver) migrate(ctx context.Context, checkout string, rec *recipe.Recipe) error {
	if rec == nil || rec.Data.Migrate == "" {
		return nil
	}
	if err := d.docker.Shell(ctx, checkout, rec.Services.Compose.Env, rec.Data.Migrate); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	return nil
}

// seed runs data.seed in one of its three forms.
func (d *Driver) seed(ctx context.Context, project, checkout string, rec *recipe.Recipe) error {
	if rec == nil {
		return nil
	}
	s := rec.Data.Seed
	var err error
	switch {
	case s.SQL != "":
		err = d.seedFromSQLFile(ctx, project, checkout, s, rec.HealthTimeout())
	case s.Service != "":
		err = d.docker.ComposeExec(ctx, project, s.Service, nil, "sh", "-c", s.Command)
	case s.Command != "":
		err = d.docker.Shell(ctx, checkout, rec.Services.Compose.Env, s.Command)
	}
	if err != nil {
		return fmt.Errorf("seed: %w", err)
	}
	return nil
}

// seedFromSQLFile pipes the file to psql in a postgres service, once the
// server answers over TCP: during initdb the image's temporary server
// answers on the socket only, and restarts afterwards.
func (d *Driver) seedFromSQLFile(ctx context.Context, project, checkout string, s recipe.Seed, timeout time.Duration) error {
	sql, err := os.ReadFile(filepath.Join(checkout, s.SQL))
	if err != nil {
		return err
	}
	user, db := s.User, s.Database
	if user == "" {
		user = "postgres"
	}
	if db == "" {
		db = user
	}
	if err := d.retryUntil(ctx, timeout, func() error {
		return d.docker.ComposeExec(ctx, project, s.Service, nil, "pg_isready", "-q", "-h", "127.0.0.1", "-U", user, "-d", db)
	}); err != nil {
		return fmt.Errorf("postgres in %s never got ready: %w", s.Service, err)
	}
	return d.docker.ComposeExec(ctx, project, s.Service, sql, "psql", "-q", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-U", user, "-d", db)
}

// seedFingerprint identifies the data a round starts from (the manifest's
// seedSha): the migrate and seed commands and the SQL file's bytes.
func seedFingerprint(checkout string, rec *recipe.Recipe) string {
	if rec == nil || !rec.SeedsData() {
		return "none"
	}
	h := sha256.New()
	fmt.Fprintf(h, "migrate\x00%s\x00seed\x00%s\x00%s\x00", rec.Data.Migrate, rec.Data.Seed.Service, rec.Data.Seed.Command)
	if rec.Data.Seed.SQL != "" {
		b, _ := os.ReadFile(filepath.Join(checkout, rec.Data.Seed.SQL))
		h.Write(b)
	}
	return hex.EncodeToString(h.Sum(nil))
}
