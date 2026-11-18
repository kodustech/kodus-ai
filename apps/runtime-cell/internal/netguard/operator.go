package netguard

import (
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"maps"
	"slices"
	"strings"
)

// DenyFlags are the operator's deny list as the proxy (cmd/egress) and the
// resolver (cmd/resolver) both read it: the same flags, the same format,
// one parser. Give both processes the same values; each reports
// DenyList.Fingerprint on its policy pushes and the cell refuses a push the
// two disagree on (control.ErrDenyListsDiffer).
type DenyFlags struct {
	hosts, owned string
}

// RegisterDenyFlags adds -deny-hosts and -owned-hosts to fs.
func RegisterDenyFlags(fs *flag.FlagSet) *DenyFlags {
	f := &DenyFlags{}
	fs.StringVar(&f.hosts, "deny-hosts", "", "comma-separated hosts the operator denies on top of the Kodus list: an exact host, or .domain for every name under it (the proxy and the resolver must get the same value: the cell refuses a policy push they disagree on)")
	fs.StringVar(&f.owned, "owned-hosts", "", "comma-separated hosts the cell owns (evidence bucket), let through the Kodus deny list (same value on the proxy and the resolver)")
	return f
}

// List is the deny list the flags name; moreOwned are further owned hosts
// in the same comma-separated format (a deprecated flag's value).
func (f *DenyFlags) List(moreOwned ...string) (DenyList, error) {
	return ParseDenyList(f.hosts, ParseOwnedHosts(strings.Join(append([]string{f.owned}, moreOwned...), ",")))
}

// Fingerprint names what the operator configured (its entries and the
// owned hosts), whatever the order or spelling it was written in. The
// Kodus list is not in it: it is the binary's, and a rollout may run two
// versions side by side.
func (l DenyList) Fingerprint() string {
	owned := slices.Clone([]string(l.owned))
	slices.Sort(owned)
	suffix := slices.Clone(l.suffix)
	slices.Sort(suffix)
	var b strings.Builder
	for _, part := range [][]string{slices.Sorted(maps.Keys(l.exact)), slices.Compact(suffix), slices.Compact(owned)} {
		b.WriteString(strings.Join(part, ","))
		b.WriteByte('\n')
	}
	sum := sha256.Sum256([]byte(b.String()))
	return "sha256:" + hex.EncodeToString(sum[:])
}
