package conformance

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
)

// The snapshot behaviours (docs/runtime/isolation-p3-snapshots.md "Acceptance
// tests"). Each fails on the hazard it names when the backend does not
// handle it.

func needSnapshots(t *testing.T, tg Target) {
	t.Helper()
	if tg.Snapshots == nil {
		t.Skip("pending until P3: " + tg.Name + " keeps no memory snapshot")
	}
}

// template makes a setup's sandbox, lets prep run in it, and keeps it as a
// template of org; the sandbox ends.
func template(t *testing.T, tg Target, org string, prep func(*box)) isolation.SnapshotRef {
	t.Helper()
	b := newBoxWith(t, tg, org, func(s *driver.MachineSpec) { s.Setup = true })
	if prep != nil {
		prep(b)
	}
	_ = b.client.Close()
	start := time.Now()
	snap, err := tg.Snapshots.Snapshot(context.Background(), b.ref, isolation.PurposeTemplate)
	if err != nil {
		t.Fatalf("template: %v", err)
	}
	t.Logf("template %s of %s: %d ms", snap.ID, b.ref.MachineID, time.Since(start).Milliseconds())
	t.Cleanup(func() { _ = tg.Snapshots.Forget(context.Background(), snap) })
	b.gone = true
	_ = tg.Driver.ReleaseClaim(context.Background(), b.net)
	return snap
}

// restoreBox makes a sandbox of org on claim from snap, released when the
// test ends, and logs the time to its guest agent's first answer.
func restoreBox(t *testing.T, tg Target, snap isolation.SnapshotRef, org, claim string, n driver.ClaimNetwork, role driver.Role) *box {
	t.Helper()
	start := time.Now()
	ref, err := tg.Snapshots.Restore(context.Background(), sandboxSpec(tg, org, claim, n, role), snap)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	restored := time.Since(start)
	b := &box{tg: tg, ref: ref, net: n, org: org, claim: claim}
	t.Cleanup(func() { _ = b.client.Close(); _ = tg.Driver.Destroy(context.Background(), ref) })
	b.client = b.dial(t)
	t.Logf("restore %s: %d ms to the rebirth, %d ms to the guest agent's first answer", ref.MachineID, restored.Milliseconds(), time.Since(start).Milliseconds())
	return b
}

// Two machines restored from one template never share the kernel's random
// state or the machine's ids, even an id the template's kernel had made
// before the snapshot (its boot_id, read there on purpose), and both hold
// the template's files.
func aRestoredCloneGetsANewEntropySeedAndIDs(t *testing.T, tg Target) {
	needSnapshots(t, tg)
	var before string
	snap := template(t, tg, "org-conf-a", func(b *box) {
		b.write(t, "kept.txt", "from the template")
		before = b.sh(t, `cat /proc/sys/kernel/random/boot_id; hostname`).Stdout
	})
	claim, n := newClaim(t, tg, "org-conf-a")
	ids := `cat /proc/sys/kernel/random/boot_id; hostname; cat /etc/machine-id 2>/dev/null || echo no-machine-id
head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'; echo
python3 -c 'import os; print(os.urandom(16).hex())'
cat /sys/class/net/eth0/address`
	var got [][]string
	for _, role := range []driver.Role{driver.RoleWorkload, driver.RolePool} {
		c := restoreBox(t, tg, snap, "org-conf-a", claim, n, role)
		if kept, err := c.read(t, "kept.txt"); err != nil || kept != "from the template" {
			t.Fatalf("the template's file in the clone: %q %v", kept, err)
		}
		r := c.sh(t, ids)
		if r.ExitCode != 0 {
			t.Fatalf("ids: %d %s", r.ExitCode, r.Stderr)
		}
		got = append(got, strings.Split(strings.TrimSpace(r.Stdout), "\n"))
	}
	names := []string{"boot_id", "hostname", "machine-id", "first /dev/urandom read", "os.urandom", "MAC"}
	tpl := strings.Split(strings.TrimSpace(before), "\n")
	for i, name := range names {
		if i >= len(got[0]) || i >= len(got[1]) {
			t.Fatalf("ids %q %q", got[0], got[1])
		}
		if got[0][i] == "no-machine-id" && got[1][i] == "no-machine-id" {
			continue // the image has none: nothing to share
		}
		if got[0][i] == got[1][i] {
			t.Errorf("two clones share their %s %q", name, got[0][i])
		}
		if i < len(tpl) && (got[0][i] == tpl[i] || got[1][i] == tpl[i]) {
			t.Errorf("a clone kept the template's %s %q", name, tpl[i])
		}
	}
}

// A machine restored from a template made seconds ago reads the host's
// time, not the template's.
func aRestoredClonesClockIsTheHosts(t *testing.T, tg Target) {
	needSnapshots(t, tg)
	snap := template(t, tg, "org-conf-a", nil)
	time.Sleep(3 * time.Second) // the template's clock is 3 s behind from here
	claim, n := newClaim(t, tg, "org-conf-a")
	c := restoreBox(t, tg, snap, "org-conf-a", claim, n, driver.RoleWorkload)
	const slack = 50 * time.Millisecond
	before := time.Now()
	r := c.sh(t, "date +%s%N")
	after := time.Now()
	ns, err := strconv.ParseInt(strings.TrimSpace(r.Stdout), 10, 64)
	if err != nil {
		t.Fatalf("date: %q %v", r.Stdout, err)
	}
	guest := time.Unix(0, ns)
	if guest.Before(before.Add(-slack)) || guest.After(after.Add(slack)) {
		t.Fatalf("the clone's clock is %v off the host's (window %v)", guest.Sub(before), after.Sub(before))
	}
	t.Logf("clone clock %+.1f ms from the host's (exec window %.1f ms)", float64(guest.Sub(before).Microseconds())/1000, float64(after.Sub(before).Microseconds())/1000)
}

// Two machines restored from one template into one claim each take their
// own MAC and address: they reach each other on the claim's bridge (whose
// fence drops a frame not from a tap's own MAC and address) and the egress.
func twoClonesHaveTheirOwnAddresses(t *testing.T, tg Target) {
	needSnapshots(t, tg)
	snap := template(t, tg, "org-conf-a", nil)
	claim, n := newClaim(t, tg, "org-conf-a")
	one := restoreBox(t, tg, snap, "org-conf-a", claim, n, driver.RoleWorkload)
	two := restoreBox(t, tg, snap, "org-conf-a", claim, n, driver.RolePool)
	if one.ref.PrivateAddress == "" || one.ref.PrivateAddress == two.ref.PrivateAddress {
		t.Fatalf("addresses %q %q", one.ref.PrivateAddress, two.ref.PrivateAddress)
	}
	if a, b := one.sh(t, "cat /sys/class/net/eth0/address").Stdout, two.sh(t, "cat /sys/class/net/eth0/address").Stdout; a == b {
		t.Fatalf("two clones on one bridge share the MAC %s", a)
	}
	served := make(chan string, 1)
	go func() {
		r := two.python(t, `import socket
s = socket.socket(); s.bind(("0.0.0.0", 8080)); s.listen(1); s.settimeout(30)
c, a = s.accept(); c.sendall(b"hi"); c.close(); print(a[0])`)
		served <- strings.TrimSpace(r.Stdout)
	}()
	got := one.python(t, fmt.Sprintf(`import socket, sys, time
for _ in range(100):
    try:
        s = socket.create_connection((%q, 8080), timeout=1); print(s.recv(2).decode()); sys.exit(0)
    except OSError as e:
        err = e; time.sleep(0.2)
print("refused", err); sys.exit(1)`, two.ref.PrivateAddress))
	if srv := <-served; got.ExitCode != 0 || strings.TrimSpace(got.Stdout) != "hi" || srv != one.ref.PrivateAddress {
		t.Fatalf("%s -> %s: client %d %q %q, the server saw %q", one.ref.PrivateAddress, two.ref.PrivateAddress, got.ExitCode, got.Stdout, got.Stderr, srv)
	}
	if tg.Egress == nil {
		return
	}
	if err := tg.Egress.Allow(context.Background(), claim, "org-conf-a", n, []string{one.ref.PrivateAddress, two.ref.PrivateAddress}, []string{tg.AllowedHost}); err != nil {
		t.Fatal(err)
	}
	for _, c := range []*box{one, two} {
		if r := c.sh(t, "python3 -c "+shellQuote(fetch)+" "+shellQuote("https://"+tg.AllowedHost+"/")); r.ExitCode != 0 {
			t.Errorf("%s does not reach the allowed host through the egress: %s %s", c.ref.MachineID, r.Stdout, r.Stderr)
		}
	}
}

// A machine of a claim that hands it the org's secrets never becomes a
// snapshot, of either kind, and runs on after the refusal.
func aMachineHandedSecretsNeverBecomesASnapshot(t *testing.T, tg Target) {
	needSnapshots(t, tg)
	b := newBoxWith(t, tg, "org-conf-a", func(s *driver.MachineSpec) { s.Setup, s.Secrets = true, true })
	for _, p := range []isolation.Purpose{isolation.PurposeTemplate, isolation.PurposeSession} {
		if snap, err := tg.Snapshots.Snapshot(context.Background(), b.ref, p); err == nil {
			t.Fatalf("a machine with secrets became a %s: %+v", p, snap)
		}
	}
	if r := b.sh(t, "echo alive"); r.ExitCode != 0 || strings.TrimSpace(r.Stdout) != "alive" {
		t.Fatalf("after the refusal: %+v", r)
	}
}

// A template of one org never restores into a machine of another, whatever
// org the snapshot's reference names.
func aTemplateNeverRestoresIntoAnotherOrg(t *testing.T, tg Target) {
	needSnapshots(t, tg)
	snap := template(t, tg, "org-conf-a", nil)
	claim, n := newClaim(t, tg, "org-conf-b")
	for _, ref := range []isolation.SnapshotRef{snap, func() isolation.SnapshotRef { f := snap; f.Org = "org-conf-b"; return f }()} {
		if m, err := tg.Snapshots.Restore(context.Background(), sandboxSpec(tg, "org-conf-b", claim, n, driver.RoleWorkload), ref); err == nil {
			_ = tg.Driver.Destroy(context.Background(), m)
			t.Fatalf("org b restored org a's template through %+v", ref)
		}
	}
}

// A sandbox becomes a template only while no process of its workload runs
// (each would carry its own random state into every clone); the refusal
// leaves the sandbox running.
func aSandboxTemplateRefusesWhileAWorkloadProcessRuns(t *testing.T, tg Target) {
	needSnapshots(t, tg)
	b := newBoxWith(t, tg, "org-conf-a", func(s *driver.MachineSpec) { s.Setup = true })
	if r := b.sh(t, "nohup sleep 600 >/dev/null 2>&1 & echo started"); r.ExitCode != 0 {
		t.Fatal(r.Stderr)
	}
	if snap, err := tg.Snapshots.Snapshot(context.Background(), b.ref, isolation.PurposeTemplate); err == nil {
		t.Fatalf("a template with a workload process: %+v", snap)
	} else {
		t.Logf("refused: %v", err)
	}
	_ = b.client.Close()
	b.client = b.dial(t)
	if r := b.sh(t, "echo alive"); r.ExitCode != 0 || strings.TrimSpace(r.Stdout) != "alive" {
		t.Fatalf("after the refusal: %+v", r)
	}
}

// A session comes back once, with its files and its processes; a second
// restore finds nothing.
func aSessionRestoresOnceWithItsFilesAndProcesses(t *testing.T, tg Target) {
	needSnapshots(t, tg)
	b := newBox(t, tg, "org-conf-a", driver.ClaimSize{}, driver.RoleWorkload)
	b.write(t, "kept.txt", "kept")
	if r := b.sh(t, "nohup sleep 600 >/dev/null 2>&1 & echo $! > sleeper.pid"); r.ExitCode != 0 {
		t.Fatal(r.Stderr)
	}
	_ = b.client.Close()
	snap, err := tg.Snapshots.Snapshot(context.Background(), b.ref, isolation.PurposeSession)
	if err != nil {
		t.Fatal(err)
	}
	b.gone = true
	claim, n := newClaim(t, tg, "org-conf-a")
	c := restoreBox(t, tg, snap, "org-conf-a", claim, n, driver.RoleWorkload)
	if got, err := c.read(t, "kept.txt"); err != nil || got != "kept" {
		t.Fatalf("file after the restore: %q %v", got, err)
	}
	if r := c.sh(t, `kill -0 "$(cat sleeper.pid)"`); r.ExitCode != 0 {
		t.Fatal("the process did not come back with its session")
	}
	claim2, n2 := newClaim(t, tg, "org-conf-a")
	if m, err := tg.Snapshots.Restore(context.Background(), sandboxSpec(tg, "org-conf-a", claim2, n2, driver.RoleWorkload), snap); err == nil {
		_ = tg.Driver.Destroy(context.Background(), m)
		t.Fatal("a session restored twice")
	}
}

// A paused machine comes back with its files and its processes.
func pauseThenResumeKeepsFilesAndProcesses(t *testing.T, tg Target) {
	if tg.Snapshots == nil {
		t.Skip("pending until P3: " + tg.Name + " pauses no sandbox machine")
	}
	b := newBox(t, tg, "org-conf-a", driver.ClaimSize{}, driver.RoleWorkload)
	b.write(t, "kept.txt", "kept")
	if r := b.sh(t, "nohup sleep 600 >/dev/null 2>&1 & echo $! > sleeper.pid"); r.ExitCode != 0 {
		t.Fatal(r.Stderr)
	}
	if err := tg.Snapshots.Pause(context.Background(), b.ref); err != nil {
		t.Fatal(err)
	}
	if err := tg.Snapshots.Resume(context.Background(), b.ref); err != nil {
		t.Fatal(err)
	}
	_ = b.client.Close()
	b.client = b.dial(t)
	if got, err := b.read(t, "kept.txt"); err != nil || got != "kept" {
		t.Fatalf("file after resume: %q %v", got, err)
	}
	if r := b.sh(t, `kill -0 "$(cat sleeper.pid)"`); r.ExitCode != 0 {
		t.Fatal("the process did not survive the pause")
	}
}
