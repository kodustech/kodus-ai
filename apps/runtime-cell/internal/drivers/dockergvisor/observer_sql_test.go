package dockergvisor

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
)

const observerRecipe = `version: 1
services:
  compose: { public: app }
  expose: [{ service: db, port: 5432, kind: postgres, readonly_user_from_seed: true }]
data:
  seed: { service: db, sql: db/seed.sql, user: shop, database: shop }
`

func sqlDriver(t *testing.T, text string) (*Driver, *memDocker, driver.MachineRef, string) {
	t.Helper()
	d, docker, ref, dir, _ := stepsDriver(t, text)
	docker.containers[ref.MachineID] = dockercli.Container{ID: ref.MachineID, Name: ref.MachineID, Labels: toLabels(map[string]string{driver.TagCell: d.cfg.CellID, driver.TagRole: string(driver.RoleWorkload), driver.TagHardExpires: d.clock.Now().Add(time.Hour).UTC().Format(time.RFC3339)})}
	c := docker.containers[ref.MachineID]
	c.Labels[labelMachine] = ref.MachineID
	docker.containers[ref.MachineID] = c
	return d, docker, ref, dir
}

// The declaration used to be parsed but never provisioned an observer account.
func TestSQLObserverProvisioningUsesOwnedContainerStdinAndRetainsOnlyClaimState(t *testing.T) {
	d, docker, ref, dir := sqlDriver(t, observerRecipe)
	creds, err := d.ProvisionObserverSQL(context.Background(), ref, dir)
	if err != nil || len(creds) != 1 {
		t.Fatalf("provisioning: %v count=%d", err, len(creds))
	}
	c := creds[0]
	if c.Service != "db" || c.Database != "shop" || c.Port != 5432 || c.Validate() != nil {
		t.Fatal("invalid credential mapping")
	}
	if len(docker.inputs) != 1 || docker.inputs[0].container != "cdb" {
		t.Fatal("not provisioned in owned database container")
	}
	in := docker.inputs[0]
	if strings.Contains(in.stdin, c.Password) || strings.Contains(strings.Join(in.argv, " "), c.Password) || strings.Contains(strings.Join(in.argv, " "), "SCRAM") {
		t.Fatal("secret crossed plaintext command path")
	}
	if !strings.Contains(in.stdin, "SCRAM-SHA-256") {
		t.Fatal("no verifier passed")
	}
	again, err := d.ProvisionObserverSQL(context.Background(), ref, dir)
	if err != nil || len(again) != 1 || again[0] != c {
		t.Fatal("reset rotated credential without observer reconfiguration")
	}
	if len(d.ObserverSQLSecrets(ref.MachineID)) < 1 || len(d.ObserverSQLCredentials(ref.MachineID)) != 1 {
		t.Fatal("no claim-only credential source")
	}
	d.ForgetObserverSQL(ref.MachineID)
	if len(d.ObserverSQLSecrets(ref.MachineID)) != 0 || len(d.ObserverSQLCredentials(ref.MachineID)) != 0 {
		t.Fatal("cleanup retained credential")
	}
	next, err := d.ProvisionObserverSQL(context.Background(), ref, dir)
	if err != nil || next[0].Password == c.Password {
		t.Fatal("new claim reused old credential")
	}
}

func TestSQLObserverProvisioningRefusesUnsupportedSeedTargetsBeforeExec(t *testing.T) {
	for _, text := range []string{
		strings.Replace(observerRecipe, "kind: postgres", "kind: mysql", 1),
		strings.Replace(observerRecipe, "user: shop, database: shop", "user: shop", 1),
		strings.Replace(observerRecipe, "service: db, sql:", "service: other, sql:", 1),
	} {
		d, docker, ref, dir := sqlDriver(t, text)
		_, err := d.ProvisionObserverSQL(context.Background(), ref, dir)
		var refused *driver.ObserverSQLError
		if !errors.As(err, &refused) || len(docker.inputs) != 0 {
			t.Fatal("unsupported target reached database or lost typed refusal")
		}
	}
}

func TestSQLObserverProvisioningDoesNotReturnGuestErrorOrOutput(t *testing.T) {
	d, docker, ref, dir := sqlDriver(t, observerRecipe)
	docker.inputErr = errors.New("password=fixture-do-not-return")
	_, err := d.ProvisionObserverSQL(context.Background(), ref, dir)
	if err == nil || strings.Contains(err.Error(), "fixture-do-not-return") {
		t.Fatal("guest error escaped")
	}
}

type blockedObserverSQLDocker struct {
	*memDocker
	entered chan struct{}
	resume  chan struct{}
}

func (b *blockedObserverSQLDocker) ExecInput(context.Context, string, []byte, ...string) ([]byte, error) {
	close(b.entered)
	<-b.resume
	return nil, nil
}

func TestSQLObserverCleanupDoesNotWaitForGuestOrResurrectCredentials(t *testing.T) {
	d, docker, ref, dir := sqlDriver(t, observerRecipe)
	b := &blockedObserverSQLDocker{memDocker: docker, entered: make(chan struct{}), resume: make(chan struct{})}
	d.d = b
	result := make(chan error, 1)
	go func() { _, err := d.ProvisionObserverSQL(context.Background(), ref, dir); result <- err }()
	<-b.entered
	removed := make(chan struct{})
	go func() { d.ForgetObserverSQL(ref.MachineID); close(removed) }()
	select {
	case <-removed:
	case <-time.After(time.Second):
		close(b.resume)
		<-result
		t.Fatal("cleanup waited for untrusted database I/O")
	}
	close(b.resume)
	if err := <-result; err == nil {
		t.Fatal("completed provisioner resurrected a released credential")
	}
	if len(d.ObserverSQLCredentials(ref.MachineID)) != 0 || len(d.ObserverSQLSecrets(ref.MachineID)) != 0 {
		t.Fatal("released credential survived")
	}
}

func TestSQLObserverProvisioningNoDeclarationAndForeignOwnershipCannotGrantCredentials(t *testing.T) {
	d, docker, ref, dir := sqlDriver(t, strings.Replace(observerRecipe, "readonly_user_from_seed: true", "readonly_user_from_seed: false", 1))
	got, err := d.ProvisionObserverSQL(context.Background(), ref, dir)
	if err != nil || len(got) != 0 || len(docker.inputs) != 0 {
		t.Fatal("missing declaration provisioned an account")
	}
	d, docker, ref, dir = sqlDriver(t, observerRecipe)
	c := docker.containers[ref.MachineID]
	c.Labels = toLabels(map[string]string{driver.TagCell: "another-cell"})
	docker.containers[ref.MachineID] = c
	_, err = d.ProvisionObserverSQL(context.Background(), ref, dir)
	var refused *driver.ObserverSQLError
	if !errors.As(err, &refused) || refused.Reason != "sql_machine_unavailable" || len(docker.inputs) != 0 {
		t.Fatal("foreign workload reached provisioning")
	}
}

func TestSQLObserverCredentialGetterCopiesAndFailedProvisionHasNoReadyCredential(t *testing.T) {
	d, docker, ref, dir := sqlDriver(t, observerRecipe)
	got, err := d.ProvisionObserverSQL(context.Background(), ref, dir)
	if err != nil {
		t.Fatal(err)
	}
	saved := got[0]
	got[0].Password = "changed-by-reader"
	if d.ObserverSQLCredentials(ref.MachineID)[0] != saved {
		t.Fatal("credential getter exposed mutable storage")
	}
	docker.inputErr = errors.New("KODY_OBSERVER_SCHEMA_UNSAFE fixture-secret")
	_, err = d.ProvisionObserverSQL(context.Background(), ref, dir)
	var refused *driver.ObserverSQLError
	if !errors.As(err, &refused) || refused.Reason != "sql_schema_unsafe" || len(d.ObserverSQLCredentials(ref.MachineID)) != 0 {
		t.Fatal("unsafe schema kept ready credentials")
	}
	if strings.Contains(err.Error(), "fixture-secret") {
		t.Fatal("database output escaped typed error")
	}
}

func TestSQLObserverExpiryComesFromOwnedHolderAndNeverExtendsOnReset(t *testing.T) {
	d, docker, ref, dir := sqlDriver(t, observerRecipe)
	hard := docker.containers[ref.MachineID].Labels[dockercli.LabelFromTag(driver.TagHardExpires)]
	ref.Tags = map[string]string{driver.TagHardExpires: d.clock.Now().Add(100 * time.Hour).Format(time.RFC3339)}
	if _, err := d.ProvisionObserverSQL(context.Background(), ref, dir); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(docker.inputs[0].stdin, "VALID UNTIL '"+hard+"'") {
		t.Fatal("role expiry did not use holder ceiling")
	}
	holder := docker.containers[ref.MachineID]
	holder.Labels[dockercli.LabelFromTag(driver.TagHardExpires)] = d.clock.Now().Add(2 * time.Hour).Format(time.RFC3339)
	docker.containers[ref.MachineID] = holder
	if _, err := d.ProvisionObserverSQL(context.Background(), ref, dir); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(docker.inputs[1].stdin, "VALID UNTIL '"+hard+"'") {
		t.Fatal("reset expanded original account ceiling")
	}
	delete(holder.Labels, dockercli.LabelFromTag(driver.TagHardExpires))
	docker.containers[ref.MachineID] = holder
	if _, err := d.ProvisionObserverSQL(context.Background(), ref, dir); err == nil || len(docker.inputs) != 2 {
		t.Fatal("missing authoritative ceiling reached database")
	}
}

type observerSQLSinkDocker struct {
	*memDocker
	leaked bool
}

func (b *observerSQLSinkDocker) ExecInput(ctx context.Context, container string, stdin []byte, argv ...string) ([]byte, error) {
	if sink := driver.OutputFrom(ctx); sink != nil {
		b.leaked = true
		sink("guest stderr containing verifier")
	}
	return b.memDocker.ExecInput(ctx, container, stdin, argv...)
}
func TestSQLObserverProvisioningDoesNotInheritProgressOutputSink(t *testing.T) {
	d, docker, ref, dir := sqlDriver(t, observerRecipe)
	b := &observerSQLSinkDocker{memDocker: docker}
	d.d = b
	var output []string
	ctx := driver.WithOutput(context.Background(), func(line string) { output = append(output, line) })
	if _, err := d.ProvisionObserverSQL(ctx, ref, dir); err != nil {
		t.Fatal(err)
	}
	if b.leaked || len(output) != 0 {
		t.Fatal("provisioning inherited public progress output")
	}
}

// A target on a non-default PostgreSQL port must never provision a different
// local instance merely because psql defaults to 5432.
func TestSQLObserverProvisioningUsesDeclaredDatabasePort(t *testing.T) {
	d, docker, ref, dir := sqlDriver(t, strings.Replace(observerRecipe, "port: 5432", "port: 5544", 1))
	got, err := d.ProvisionObserverSQL(context.Background(), ref, dir)
	if err != nil || len(got) != 1 || got[0].Port != 5544 {
		t.Fatal("declared target not provisioned")
	}
	argv := docker.inputs[0].argv
	found := false
	for i, arg := range argv {
		if arg == "-p" && i+1 < len(argv) && argv[i+1] == "5544" {
			found = true
		}
	}
	if !found {
		t.Fatal("provisioner used default PostgreSQL port instead of the declared target")
	}
}

// Cleanup can run after entropy generation starts but before an account is
// inserted. That stale generation must never publish new credential state.
func TestSQLObserverStaleAllocationCannotInstallAfterCleanup(t *testing.T) {
	d, _, ref, _ := sqlDriver(t, observerRecipe)
	d.mu.Lock()
	state := d.machines[ref.MachineID]
	generation := state.observerSQLGeneration
	d.mu.Unlock()
	account := &observerSQLAccount{}
	d.ForgetObserverSQL(ref.MachineID)
	if _, err := d.installSQLAccount(context.Background(), ref.MachineID, state, generation, account); err == nil {
		t.Fatal("stale allocation survived claim cleanup")
	}
	if len(d.ObserverSQLSecrets(ref.MachineID)) != 0 {
		t.Fatal("stale allocation retained secrets")
	}
}

func TestSQLObserverStaleAllocationCannotInstallIntoRecreatedMachine(t *testing.T) {
	d, _, ref, _ := sqlDriver(t, observerRecipe)
	d.mu.Lock()
	state := d.machines[ref.MachineID]
	d.mu.Unlock()
	d.forget(ref.MachineID)
	d.mu.Lock()
	d.machineLocked(ref.MachineID)
	d.mu.Unlock()
	if _, err := d.installSQLAccount(context.Background(), ref.MachineID, state, 0, &observerSQLAccount{}); err == nil {
		t.Fatal("old allocation crossed a machine lifetime")
	}
}
