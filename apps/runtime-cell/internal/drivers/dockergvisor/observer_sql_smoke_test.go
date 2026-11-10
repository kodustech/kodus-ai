//go:build dockersmoke

package dockergvisor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observerauth"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

type smokeSQLConfig struct {
	Claim   observer.ClaimConfig
	Missing bool
}

// TestSmokeGoldenSQLObserver combines real account provisioning, golden reset,
// and the native SQL observer on the claim network. The trusted client runs in
// its own runsc container, with no Docker socket, workspace or credential in
// argv/environment. This does not cover the deployed observer image or mTLS.
func TestSmokeGoldenSQLObserver(t *testing.T) {
	dir, file := smokeApp(t)
	writeSmoke(t, filepath.Join(dir, ".kodus", "workspace.yaml"), `version: 1
services:
  compose:
    files: [docker-compose.yml]
    public: app
    health: /health
    health_timeout: 120s
  expose:
    - { service: app, port: 3000, kind: http }
    - { service: db, port: 5432, kind: postgres, readonly_user_from_seed: true }
data:
  seed: { service: db, sql: db/seed.sql, user: shop, database: shop }
  reset: recreate
`)
	m := newSmokeMachine(t, dir, file, false, ordersState)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	var driverLogs bytes.Buffer
	m.d.cfg.Log = slog.New(slog.NewTextHandler(&driverLogs, nil))
	var credential observerauth.Credential
	var known []string
	var generation uint64
	checkLeaks := func(raw []byte) {
		t.Helper()
		for _, secret := range known {
			if secret != "" && bytes.Contains(raw, []byte(secret)) {
				t.Fatal("managed SQL credential leaked across an output boundary")
			}
		}
	}
	binary, err := os.Executable()
	if err != nil {
		t.Fatal("trusted SQL client binary unavailable")
	}
	clientName := m.ref.MachineID + "-sql-proof"
	t.Cleanup(func() {
		// Docker --rm handles ordinary exits; this also covers a test cancellation.
		_ = exec.Command("docker", "rm", "-f", clientName).Run()
	})
	client := func(missing bool) {
		t.Helper()
		targets, err := m.d.Targets(m.ref.MachineID, []observer.Target{{Service: "db", Port: 5432, Kind: "postgres"}})
		if err != nil || len(targets) != 1 {
			t.Fatal("owned database target unavailable")
		}
		config := smokeSQLConfig{Claim: observer.ClaimConfig{ClaimID: m.claim, ImageID: m.ref.ImageID, Generation: generation, Targets: targets, SQL: []observerauth.Credential{credential}}, Missing: missing}
		raw, err := json.Marshal(config)
		if err != nil {
			t.Fatal("private SQL client configuration could not be encoded")
		}
		cmd := exec.CommandContext(ctx, "docker", "run", "--rm", "--pull=never", "-i", "--name", clientName,
			"--label", "kodus.cell="+m.d.cfg.CellID, "--label", "kodus.claim="+m.claim,
			"--runtime=runsc", "--network", networkName(m.claim), "--memory=128m", "--cpus=0.5", "--pids-limit=64",
			"--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--env", "KGR_SQL_PROOF_CLIENT=1",
			"--mount", "type=bind,src="+binary+",dst=/golden-sql-proof,readonly", "alpine:3.20",
			"/golden-sql-proof", "-test.run", "^TestSmokeGoldenSQLObserverClient$", "-test.v", "-test.timeout", "30s")
		cmd.Stdin = bytes.NewReader(raw)
		output, err := cmd.CombinedOutput()
		checkLeaks(output)
		if err != nil {
			t.Fatalf("isolated SQL observer proof failed: %s", output)
		}
	}
	provision := func() {
		t.Helper()
		at := time.Now()
		credentials, err := m.d.ProvisionObserverSQL(ctx, m.ref, m.dir)
		known = m.d.ObserverSQLSecrets(m.ref.MachineID)
		checkLeaks(driverLogs.Bytes())
		if err != nil || len(credentials) != 1 {
			t.Fatalf("post-seed SQL provisioning failed (%T)", err)
		}
		if generation > 0 && credentials[0] != credential {
			t.Fatal("reset changed the claim's private SQL identity")
		}
		credential = credentials[0]
		generation++
		client(false)
		logs, err := (dockercli.CLI{}).ComposeLogs(ctx, m.ref.MachineID, "db", 256)
		if err != nil {
			t.Fatal("owned workload bounded logs unavailable")
		}
		checkLeaks(logs)
		t.Logf("observer generation %d: count=2, SCRAM auth, write/escalation refusals and no credential in output; provision/config/checks %d ms", generation, time.Since(at).Milliseconds())
	}
	provision()
	for i := range smokeResets() {
		if reset := m.reset(t, i); reset.RestoreMs == 0 {
			t.Fatal("combined lifecycle did not restore golden data")
		}
		// A golden copy predates provisioning: no observer role may survive in it.
		client(true)
		provision()
	}
	checkLeaks(driverLogs.Bytes())
	if err := m.d.Destroy(ctx, m.ref); err != nil {
		t.Fatal("owned managed workload could not be destroyed")
	}
	if len(m.d.ObserverSQLCredentials(m.ref.MachineID)) != 0 || len(m.d.ObserverSQLSecrets(m.ref.MachineID)) != 0 {
		t.Fatal("managed SQL authentication remained cached after destroy")
	}
	m.report(t)
}

// TestSmokeGoldenSQLObserverClient is the trusted client sub-process. Private
// configuration arrives only on stdin; failures expose closed diagnostics.
func TestSmokeGoldenSQLObserverClient(t *testing.T) {
	if os.Getenv("KGR_SQL_PROOF_CLIENT") != "1" {
		t.Skip("isolated SQL client mode only")
	}
	var config smokeSQLConfig
	if json.NewDecoder(io.LimitReader(os.Stdin, 64<<10)).Decode(&config) != nil || len(config.Claim.SQL) != 1 || len(config.Claim.Targets) != 1 {
		t.Fatal("invalid private SQL client configuration")
	}
	cc := config.Claim
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if config.Missing {
		db, err := observer.OpenManagedPostgres(cc.Targets[0], cc.SQL[0])
		if err != nil {
			t.Fatal("invalid missing-role fixture configuration")
		}
		defer db.Close()
		err = db.PingContext(ctx)
		var pgError *pgconn.PgError
		if !errors.As(err, &pgError) || pgError.Code != "28P01" {
			t.Fatal("golden data retained observer authentication or database was not ready")
		}
		return
	}
	server := &observer.Server{CellID: "golden-sql-proof", NewID: hubclient.NewID}
	defer server.Close()
	handler := server.Handler()
	credential := cc.SQL[0]
	known := []string{credential.Password}

	checkLeaks := func(raw []byte) {
		t.Helper()
		for _, secret := range known {
			if secret != "" && bytes.Contains(raw, []byte(secret)) {
				t.Fatal("managed SQL credential leaked across an output boundary")
			}
		}
	}
	target := func() observer.Target { return cc.Targets[0] }

	query := func() {
		t.Helper()
		stepID := hubclient.NewID()
		body := &protocol.ProbeRunBody{StepID: stepID, Probe: protocol.Probe{
			ID: "golden-seeded-count", Origin: protocol.ProbeOriginAgent,
			Purpose: "count seeded orders after golden reset", Expected: "two rows",
			Compare: []protocol.CompareField{protocol.CompareFieldDbCount},
			Spec:    protocol.ProbeSpec{SQL: &protocol.SQLProbe{Target: protocol.ProbeTarget{Service: "db", Port: 5432}, Query: "SELECT count(*) FROM public.orders", TimeoutMs: 2000}},
		}}
		raw, err := protocol.Encode(protocol.Header{ID: hubclient.NewID(), CellID: "golden-sql-proof", ClaimID: cc.ClaimID}, body)
		if err != nil {
			t.Fatal("the trusted observer probe could not be encoded")
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/run", bytes.NewReader(raw)))
		checkLeaks(w.Body.Bytes())
		checkLeaks([]byte(w.Header().Get("X-Kodus-Probe-Refused")))
		if w.Code != http.StatusOK {
			t.Fatal("the observer could not execute its managed SQL probe")
		}
		message, err := protocol.Decode(w.Body.Bytes())
		if err != nil {
			t.Fatal("the observer result violated the shared wire contract")
		}
		result, ok := message.Body.(*protocol.StepResultBody)
		if !ok || result.Executor != protocol.ExecutorObserver || result.ImageID != cc.ImageID || result.Probe == nil || result.Probe.SQL == nil || len(result.Probe.SQL.Rows) != 1 || len(result.Probe.SQL.Rows[0]) != 1 || string(result.Probe.SQL.Rows[0][0]) != "2" {
			code, _, _ := strings.Cut(w.Header().Get("X-Kodus-Probe-Refused"), ":")
			switch code {
			case "sql_error", "sql_unavailable", "sql_managed_query", "sql_not_read_only", "side_detection", "result_too_large", "":
			default:
				code = "unclassified"
			}
			if !ok || result == nil {
				t.Fatalf("the external observer result was not a step result (refusal class %s)", code)
			}
			t.Fatalf("the external observer did not independently measure the seeded count (executor matches=%t, image matches=%t, probe present=%t, refusal class=%s)", result.Executor == protocol.ExecutorObserver, result.ImageID == cc.ImageID, result.Probe != nil, code)
		}
	}
	checkRestrictedAccount := func() {
		t.Helper()
		db, err := observer.OpenManagedPostgres(target(), credential)
		if err != nil {
			t.Fatal("the managed PostgreSQL connector refused the owned target")
		}
		defer db.Close()
		conn, err := db.Conn(ctx)
		if err != nil {
			var pgError *pgconn.PgError
			state := "non_postgres"
			if errors.As(err, &pgError) && len(pgError.Code) == 5 {
				state = pgError.Code
			}
			var networkError net.Error
			t.Fatalf("managed SQL authentication failed (error class %T, SQLSTATE %s, refused=%t, network timeout=%t, auth policy=%t)", err, state, errors.Is(err, syscall.ECONNREFUSED), errors.As(err, &networkError) && networkError.Timeout(), strings.Contains(err.Error(), "authentication method requirement"))
		}
		defer conn.Close()
		// Prove actual grants, even if the client turns its session default off.
		if _, err := conn.ExecContext(ctx, "SET default_transaction_read_only=off"); err != nil {
			t.Fatal("could not isolate account grants from read-only session defaults")
		}
		for _, q := range []string{
			"INSERT INTO public.orders(item,quantity) VALUES('observer-must-not-write',1)",
			"UPDATE public.orders SET quantity=1", "DELETE FROM public.orders", "SET ROLE shop",
		} {
			_, err := conn.ExecContext(ctx, q)
			var pgError *pgconn.PgError
			if !errors.As(err, &pgError) || pgError.Code != "42501" {
				t.Fatal("the managed identity did not deny writes or role escalation by privilege")
			}
		}
		wrong := credential
		if wrong.Password[0] == 'A' {
			wrong.Password = "B" + wrong.Password[1:]
		} else {
			wrong.Password = "A" + wrong.Password[1:]
		}
		bad, err := observer.OpenManagedPostgres(target(), wrong)
		if err != nil {
			t.Fatal("wrong-password fixture configuration failed")
		}
		defer bad.Close()
		var pgError *pgconn.PgError
		if err := bad.PingContext(ctx); !errors.As(err, &pgError) || pgError.Code != "28P01" {
			t.Fatal("a different password was not refused by PostgreSQL authentication")
		}
	}
	raw, err := json.Marshal(cc)
	if err != nil {
		t.Fatal("private observer configuration could not be encoded")
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodPut, "/v1/config", bytes.NewReader(raw)))
	checkLeaks(w.Body.Bytes())
	if w.Code != http.StatusNoContent || w.Header().Get(observer.ConfigGenerationHeader) != strconv.FormatUint(cc.Generation, 10) {
		t.Fatal("observer did not bind claim generation")
	}
	checkRestrictedAccount()
	query()
}
