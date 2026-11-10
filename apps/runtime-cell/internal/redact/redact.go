package redact

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// rulesJSON is a byte-identical copy of libs/runtime/redaction/gitleaks-rules.json
// (a curated subset of gitleaks' default rules, MIT); TestRulesFileMatchesTS
// keeps the two in sync.
//
//go:embed rules/gitleaks-rules.json
var rulesJSON []byte

// RulesJSON is the embedded rule data file.
func RulesJSON() []byte { return rulesJSON }

// Rule is one token pattern.
type Rule struct {
	ID              string   `json:"id"`
	Regex           string   `json:"regex"`
	CaseInsensitive bool     `json:"caseInsensitive"`
	SecretGroup     int      `json:"secretGroup"`
	Keywords        []string `json:"keywords"`
	Examples        []string `json:"examples"`
	Source          string   `json:"source"`

	re *regexp.Regexp
}

type rulesFile struct {
	Rules []Rule `json:"rules"`
}

var defaultRules = mustLoad(rulesJSON)

func mustLoad(b []byte) []Rule {
	rules, err := LoadRules(b)
	if err != nil {
		panic(err)
	}
	return rules
}

// LoadRules parses and compiles a rule data file.
func LoadRules(b []byte) ([]Rule, error) {
	var f rulesFile
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, fmt.Errorf("redact: rules: %w", err)
	}
	for i := range f.Rules {
		r := &f.Rules[i]
		expr := r.Regex
		if r.CaseInsensitive {
			expr = "(?i)" + expr
		}
		re, err := regexp.Compile(expr)
		if err != nil {
			return nil, fmt.Errorf("redact: rule %s: %w", r.ID, err)
		}
		if r.SecretGroup > re.NumSubexp() {
			return nil, fmt.Errorf("redact: rule %s: secretGroup %d past %d groups", r.ID, r.SecretGroup, re.NumSubexp())
		}
		r.re = re
	}
	return f.Rules, nil
}

// DefaultRules are the embedded rules, in file order.
func DefaultRules() []Rule { return defaultRules }

// Marker is the one-way replacement for a value matched by rule.
func Marker(rule string) string { return "[redacted:" + rule + "]" }

// Known is an exact value the cell knows (download token, the claim's SSH
// key, a seed password, a test secret it injected), with the label its
// marker carries.
type Known struct {
	Label string
	Value string
}

// Redactor redacts the known values of one claim and the token patterns.
type Redactor struct {
	variants []variant
	rules    []Rule
}

type variant struct {
	text  string
	label string
}

// MinKnownLen is the shortest secret Mask, Contains and MaskingWriter act
// on (the injector's credential and baits): a shorter one would blank
// unrelated text. The Redactor masks every known value whatever its length,
// as the TS original does (testdata/ts-variants.json).
const MinKnownLen = 4

// New builds a redactor for these known values over the default rules.
func New(known ...Known) *Redactor {
	r := &Redactor{rules: defaultRules}
	seen := map[string]bool{}
	for _, k := range known {
		for _, v := range Variants(k.Value) {
			if !seen[v] && !strings.Contains(v, "\x00") {
				seen[v] = true
				r.variants = append(r.variants, variant{text: v, label: k.Label})
			}
		}
	}
	// Longest first, so a shorter variant never leaves the tail of a
	// longer one in place (maskSecrets).
	sort.SliceStable(r.variants, func(i, j int) bool { return len(r.variants[i].text) > len(r.variants[j].text) })
	return r
}

// String redacts s and returns the text and how many values it replaced.
func (r *Redactor) String(s string) (string, int) {
	if s == "" {
		return s, 0
	}
	n := 0
	// Sequential, longest first, like maskSecrets; each hit becomes a NUL
	// sentinel first so a shorter value can never match inside a marker
	// written by a longer one. Sentinels turn into markers at the end.
	var labels []string
	for _, v := range r.variants {
		if c := strings.Count(s, v.text); c > 0 {
			n += c
			s = strings.ReplaceAll(s, v.text, sentinel(len(labels)))
			labels = append(labels, v.label)
		}
	}
	for i := range r.rules {
		var c int
		s, c = r.rules[i].apply(s)
		n += c
	}
	if len(labels) > 0 {
		pairs := make([]string, 0, 2*len(labels))
		for i, l := range labels {
			pairs = append(pairs, sentinel(i), Marker(l))
		}
		s = strings.NewReplacer(pairs...).Replace(s)
	}
	return s, n
}

// sentinel marks the i-th replaced value until the markers go in. Its
// inside is a private-use code point, not digits: a short known value ("1")
// must not match inside an earlier sentinel and break it.
func sentinel(i int) string { return "\x00" + string(rune(0xF0000+i)) + "\x00" }

// Patterns runs only the token-pattern pass (no known values).
func Patterns(s string) (string, int) { return (&Redactor{rules: defaultRules}).String(s) }

func (rule *Rule) apply(s string) (string, int) {
	if len(rule.Keywords) > 0 {
		lower := strings.ToLower(s)
		hit := false
		for _, k := range rule.Keywords {
			if strings.Contains(lower, k) {
				hit = true
				break
			}
		}
		if !hit {
			return s, 0
		}
	}
	matches := rule.re.FindAllStringSubmatchIndex(s, -1)
	if len(matches) == 0 {
		return s, 0
	}
	var out strings.Builder
	last, n := 0, 0
	for _, m := range matches {
		start, end := m[0], m[1]
		if g := rule.SecretGroup; g > 0 {
			start, end = m[2*g], m[2*g+1]
		}
		if start < 0 || start < last {
			continue
		}
		out.WriteString(s[last:start])
		out.WriteString(Marker(rule.ID))
		last = end
		n++
	}
	out.WriteString(s[last:])
	return out.String(), n
}
