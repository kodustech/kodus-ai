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
