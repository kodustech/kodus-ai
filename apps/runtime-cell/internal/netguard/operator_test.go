package netguard

import (
	"flag"
	"testing"
)

// The proxy and the resolver each read the operator's list from their own
// flags; the cell compares the fingerprints they report on every policy push
// (control.ErrDenyListsDiffer). Two copies that say the same thing must agree
// however they are written, and two that do not must differ.

func TestTheSameOperatorListHasOneFingerprintHoweverItIsWritten(t *testing.T) {
	a, err := ParseDenyList("files.example,.corp.example", ParseOwnedHosts("evidence.s3.amazonaws.com"))
	if err != nil {
		t.Fatal(err)
	}
	b, err := ParseDenyList(" .Corp.Example. , FILES.example,files.example", ParseOwnedHosts("Evidence.S3.amazonaws.com."))
	if err != nil {
		t.Fatal(err)
	}
	if a.Fingerprint() != b.Fingerprint() {
		t.Fatalf("same list, two fingerprints: %s %s", a.Fingerprint(), b.Fingerprint())
	}
	var zero DenyList
	empty, _ := ParseDenyList("", nil)
	if zero.Fingerprint() != empty.Fingerprint() {
		t.Fatal("the zero list and an empty -deny-hosts differ")
	}
}

func TestADifferentOperatorListHasAnotherFingerprint(t *testing.T) {
	base, _ := ParseDenyList(".corp.example", nil)
	for name, other := range map[string]struct{ hosts, owned string }{
		"one more host":       {".corp.example,files.example", ""},
		"exact, not a domain": {"corp.example", ""},
		"no operator entry":   {"", ""},
		"another owned host":  {".corp.example", "evidence.s3.amazonaws.com"},
		"a different domain":  {".corp2.example", ""},
	} {
		l, err := ParseDenyList(other.hosts, ParseOwnedHosts(other.owned))
		if err != nil {
			t.Fatal(err)
		}
		if l.Fingerprint() == base.Fingerprint() {
			t.Errorf("%s: same fingerprint as -deny-hosts=.corp.example", name)
		}
	}
}

func TestTheDenyFlagsReadTheOperatorsList(t *testing.T) {
	fs := flag.NewFlagSet("x", flag.ContinueOnError)
	f := RegisterDenyFlags(fs)
	if err := fs.Parse([]string{"-deny-hosts", ".corp.example", "-owned-hosts", "evidence.s3.amazonaws.com"}); err != nil {
		t.Fatal(err)
	}
	l, err := f.List()
	if err != nil {
		t.Fatal(err)
	}
	if !l.Denies("git.corp.example") || l.Denies("evidence.s3.amazonaws.com") || !l.Denies("pastebin.com") {
		t.Fatal("the flags' list is not the operator's")
	}
	if want, _ := ParseDenyList(".corp.example", ParseOwnedHosts("evidence.s3.amazonaws.com")); l.Fingerprint() != want.Fingerprint() {
		t.Fatal("the flags' list differs from the same value parsed directly")
	}
	fs = flag.NewFlagSet("x", flag.ContinueOnError)
	f = RegisterDenyFlags(fs)
	if err := fs.Parse([]string{"-deny-hosts", "*.corp.example"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.List(); err == nil {
		t.Fatal("a wildcard entry was taken")
	}
}
