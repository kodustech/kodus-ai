package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// commandOf is the shell command of script (continuation lines joined)
// that contains marker.
func commandOf(t *testing.T, script, marker string) string {
	t.Helper()
	for _, c := range strings.Split(strings.ReplaceAll(script, "\\\n", " "), "\n") {
		if strings.Contains(c, marker) {
			return c
		}
	}
	t.Fatalf("no command with %q", marker)
	return ""
}

// flagOf is the value a command gives flag, as written ("$VAR:8443").
func flagOf(t *testing.T, command, flag string) string {
	t.Helper()
	m := regexp.MustCompile(`\s` + regexp.QuoteMeta(flag) + `\s+("[^"]*"|\S+)`).FindStringSubmatch(command)
	if m == nil {
		t.Fatalf("no %s in %q", flag, command)
	}
	return strings.Trim(m[1], `"`)
}

// The dev cell's egress is handed the injector's address, and the injector
// trusts the egress's: dev-gvisor-cell.sh used to start the egress with no
// -injector-addr and the injector with no -trusted-proxies, so a secret's
// host was refused on the real cell (2026-11-13) while every in-process
// test passed.
func TestTheDevCellHandsTheEgressTheInjectorThatTrustsIt(t *testing.T) {
	b, err := os.ReadFile("../../scripts/dev-gvisor-cell.sh")
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	egress := commandOf(t, s, "/etc/kodus/egress/egress ")
	injector := commandOf(t, s, "/etc/kodus/injector/injector ")
	if addr, listen := flagOf(t, egress, "-injector-addr"), flagOf(t, injector, "-listen"); addr != listen {
		t.Fatalf("the egress sends credentialed hosts to %s; the injector listens on %s", addr, listen)
	}
	trusted := flagOf(t, injector, "-trusted-proxies")
	egressIP := flagOf(t, commandOf(t, s, `"$ENFORCERS" "$EGRESS"`), "--ip")
	injectorIP := flagOf(t, commandOf(t, s, `"$ENFORCERS" "$INJECTOR"`), "--ip")
	if trusted != egressIP {
		t.Fatalf("the injector trusts %s; the egress joins the enforcers' network as %s", trusted, egressIP)
	}
	if addr := flagOf(t, egress, "-injector-addr"); addr != injectorIP+":8443" {
		t.Fatalf("the egress dials %s; the injector joins the enforcers' network as %s", addr, injectorIP)
	}
}

// A dev cell keeps each environment's BuildKit state unless the operator turns
// it off (off sends every Run down the slow cache path), runs the cell
// binaries from a root-owned directory under /usr/local/lib (the extractor
// runs as another user and cannot exec a binary under the operator's home),
// and says what to do when the builder image cannot be pulled.
func TestTheDevCellDefaults(t *testing.T) {
	b, err := os.ReadFile("../../scripts/dev-gvisor-cell.sh")
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, want := range []string{
		`BUILD_STATE="${BUILD_STATE-1}"`,              // on unless the operator sets it empty or 0
		`BIN_INSTALL="${BIN_INSTALL:-/usr/local/lib/`, // not the user's home
		`install -d -m 0755 "$BIN_INSTALL"`,           // readable by the extractor's user
		`BUILDER_TRUST=1`,                             // the message names the flag
		`docker buildx bake runtime-builder`,          // and how to build it locally
		`-gvisor-builder-trust`,
		`-gvisor-build-state-min-free-gb "$BUILD_STATE_MIN_FREE_GB"`, // the floor the script checks is the one the cell gets
		`BUILD_STATE_MIN_FREE_GB="${BUILD_STATE_MIN_FREE_GB:-20}"`,   // the cell's own default
		`reflink=1`, // says whether the state's filesystem has reflinks
		`-gvisor-mirror-artifacts "http://mirror.cell.internal:8080/artifacts/"`, // Prisma, MongoDB and Firebase emulator downloads go through the mirror
	} {
		if !strings.Contains(s, want) {
			t.Errorf("dev-gvisor-cell.sh lacks %q", want)
		}
	}
	if strings.Contains(s, `exec_cell=("$BIN/cell"`) && !strings.Contains(s, `BIN="$BIN_INSTALL"`) {
		t.Error("the cell must run from the installed directory, not the operator's bin dir")
	}
}
