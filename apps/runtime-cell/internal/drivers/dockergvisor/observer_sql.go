package dockergvisor

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observerauth"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

var _ driver.SQLObserverProvisioner = (*Driver)(nil)

// Account state lives outside machine snapshots and bake output. Only the
// database's verifier is sent into the guest, never its plaintext password.
type observerSQLAccount struct {
	// op orders provisioning attempts without blocking cleanup/redaction reads.
	op             sync.Mutex
	mu             sync.Mutex
	credential     observerauth.Credential
	verifier       string
	expiresAt      time.Time
	ready, removed bool
}

const observerSQLTimeout = 30 * time.Second

func sqlObserverTarget(rec *recipe.Recipe) (*recipe.ExposedPort, error) {
	if rec == nil {
		return nil, nil
	}
	var selected *recipe.ExposedPort
	for _, target := range rec.Services.Expose {
		if !target.ReadonlyUserFromSeed {
			continue
		}
		if selected != nil || target.Kind != "postgres" {
			return nil, &driver.ObserverSQLError{Reason: "sql_seed_target_unsupported"}
		}
		copy := target
		selected = &copy
	}
	if selected == nil {
		return nil, nil
	}
	seed := rec.Data.Seed
	if seed.Service != selected.Service || seed.User == "" || seed.Database == "" || strings.HasPrefix(seed.User, "-") || !sqlSeedIdentifier(seed.User) {
		return nil, &driver.ObserverSQLError{Reason: "sql_seed_target_unsupported"}
	}
	// NewCredential has the same database/service grammar as the receiver;
	// validate the target before generating or storing a credential.
	probe := observerauth.Credential{Service: selected.Service, Port: selected.Port, Database: seed.Database, Username: "kody_observer_" + strings.Repeat("a", 32), Password: strings.Repeat("A", 43)}
	if probe.Validate() != nil {
		return nil, &driver.ObserverSQLError{Reason: "sql_seed_target_unsupported"}
	}
	return selected, nil
}

func sqlSeedIdentifier(s string) bool {
	if len(s) < 1 || len(s) > 63 {
		return false
	}
	for i, c := range s {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || (i > 0 && ((c >= '0' && c <= '9') || c == '-')) {
			continue
		}
		return false
	}
	return true
}

func (d *Driver) sqlAccount(ctx context.Context, machine string, target recipe.ExposedPort, database string, expiresAt time.Time) (*observerSQLAccount, error) {
	d.mu.Lock()
	state := d.machines[machine]
	if state == nil || ctx.Err() != nil {
		d.mu.Unlock()
		return nil, &driver.ObserverSQLError{Reason: "sql_machine_unavailable"}
	}
	generation := state.observerSQLGeneration
	existing := d.observerSQL[machine]
	d.mu.Unlock()
	if existing != nil {
		return existing, nil
	}
	credential, err := observerauth.NewCredential(target.Service, target.Port, database)
	if err != nil {
		return nil, &driver.ObserverSQLError{Reason: "sql_credential_failed"}
	}
	verifier, err := observerauth.SCRAMVerifier(credential)
	if err != nil {
		return nil, &driver.ObserverSQLError{Reason: "sql_credential_failed"}
	}
	next := &observerSQLAccount{credential: credential, verifier: verifier, expiresAt: expiresAt}
	return d.installSQLAccount(ctx, machine, state, generation, next)
}

// Entropy and verifier work run outside the state lock. Installation must still
// belong to the exact machine lifetime and cleanup generation that requested it.
func (d *Driver) installSQLAccount(ctx context.Context, machine string, state *machineState, generation uint64, next *observerSQLAccount) (*observerSQLAccount, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if state == nil || d.machines[machine] != state || state.observerSQLGeneration != generation || ctx.Err() != nil {
		return nil, &driver.ObserverSQLError{Reason: "sql_machine_unavailable"}
	}
	if existing := d.observerSQL[machine]; existing != nil {
		return existing, nil
	}
	if d.observerSQL == nil {
		d.observerSQL = make(map[string]*observerSQLAccount)
	}
	d.observerSQL[machine] = next
	return next, nil
}

// ProvisionObserverSQL runs after seed and after every reset. It uses only the
// owned container target recorded by Up; a repository cannot choose a host
// command, executable, DSN or arbitrary connection URL here.
func (d *Driver) ProvisionObserverSQL(ctx context.Context, ref driver.MachineRef, projectDir string) ([]observerauth.Credential, error) {
	rec, err := recipe.Load(projectDir)
	if err != nil {
		return nil, &driver.ObserverSQLError{Reason: "sql_seed_target_unsupported"}
	}
	target, err := sqlObserverTarget(rec)
	if err != nil {
		return nil, err
	}
	if target == nil {
		return nil, nil
	}
	if exists, err := d.owned(ctx, ref.MachineID); err != nil || !exists {
		return nil, &driver.ObserverSQLError{Reason: "sql_machine_unavailable"}
	}
	hard, err := d.sqlObserverExpiry(ctx, ref.MachineID)
	if err != nil {
		return nil, err
	}
	at, ok := d.peek(ref.MachineID).targets[target.Service]
	if !ok || at.container == "" {
		return nil, &driver.ObserverSQLError{Reason: "sql_machine_unavailable"}
	}
	account, err := d.sqlAccount(ctx, ref.MachineID, *target, rec.Data.Seed.Database, hard)
	if err != nil {
		return nil, err
	}
	account.op.Lock()
	defer account.op.Unlock()
	account.mu.Lock()
	c, verifier := account.credential, account.verifier
	removed := account.removed
	expiresAt := account.expiresAt
	if hard.Before(expiresAt) {
		expiresAt = hard
		account.expiresAt = hard
	}
	account.ready = false
	account.mu.Unlock()
	if removed || c.Service != target.Service || c.Port != target.Port || c.Database != rec.Data.Seed.Database {
		return nil, &driver.ObserverSQLError{Reason: "sql_seed_target_unsupported"}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	script, err := observerauth.ProvisionSQL(c, verifier, expiresAt)
	if err != nil {
		return nil, &driver.ObserverSQLError{Reason: "sql_credential_failed"}
	}
	pctx, cancel := context.WithTimeout(ctx, observerSQLTimeout)
	defer cancel()
	pctx = driver.WithOutput(pctx, nil)
	// -X ignores .psqlrc; -w never prompts. No PG* environment, shell expansion,
	// password argument or output sink is inherited by this provisioning path.
	output, err := d.d.ExecInput(pctx, at.container, script, "/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "psql", "-X", "-q", "-w", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", strconv.Itoa(target.Port), "-U", rec.Data.Seed.User, "-d", rec.Data.Seed.Database)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		reason := "sql_provision_failed"
		if strings.Contains(err.Error(), "KODY_OBSERVER_SCHEMA_UNSAFE") || strings.Contains(string(output), "KODY_OBSERVER_SCHEMA_UNSAFE") {
			reason = "sql_schema_unsafe"
		}
		return nil, &driver.ObserverSQLError{Reason: reason}
	}
	account.mu.Lock()
	defer account.mu.Unlock()
	if account.removed {
		return nil, &driver.ObserverSQLError{Reason: "sql_machine_unavailable"}
	}
	account.ready = true
	return []observerauth.Credential{c}, nil
}

func (d *Driver) sqlAccountFor(machine string) *observerSQLAccount {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.observerSQL[machine]
}

func (d *Driver) ObserverSQLCredentials(machine string) []observerauth.Credential {
	account := d.sqlAccountFor(machine)
	if account == nil {
		return nil
	}
	account.mu.Lock()
	defer account.mu.Unlock()
	if account.removed || !account.ready {
		return nil
	}
	return []observerauth.Credential{account.credential}
}

func (d *Driver) ObserverSQLSecrets(machine string) []string {
	account := d.sqlAccountFor(machine)
	if account == nil {
		return nil
	}
	account.mu.Lock()
	defer account.mu.Unlock()
	if account.removed {
		return nil
	}
	return []string{account.credential.Password, account.verifier}
}

func (d *Driver) ForgetObserverSQL(machine string) {
	d.mu.Lock()
	if state := d.machines[machine]; state != nil {
		state.observerSQLGeneration++
	}
	account := d.observerSQL[machine]
	delete(d.observerSQL, machine)
	d.mu.Unlock()
	if account == nil {
		return
	}
	account.mu.Lock()
	defer account.mu.Unlock()
	account.ready = false
	account.removed = true
	account.credential.Password = ""
	account.verifier = ""
}

// The caller's ref/tags never authorize a longer credential lifetime.
func (d *Driver) sqlObserverExpiry(ctx context.Context, machine string) (time.Time, error) {
	holders, err := d.d.List(ctx, map[string]string{labelMachine: machine})
	if err != nil || len(holders) != 1 {
		return time.Time{}, &driver.ObserverSQLError{Reason: "sql_machine_unavailable"}
	}
	h := holders[0]
	if h.Labels[dockercli.LabelFromTag(driver.TagCell)] != d.cfg.CellID || h.Labels[dockercli.LabelFromTag(driver.TagRole)] != string(driver.RoleWorkload) {
		return time.Time{}, &driver.ObserverSQLError{Reason: "sql_machine_unavailable"}
	}
	hard, err := protocol.ParseTime(h.Labels[dockercli.LabelFromTag(driver.TagHardExpires)])
	if err != nil || !hard.After(d.clock.Now()) {
		return time.Time{}, &driver.ObserverSQLError{Reason: "sql_machine_unavailable"}
	}
	return hard, nil
}
