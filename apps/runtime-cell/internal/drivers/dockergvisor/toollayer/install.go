package toollayer

import (
	"regexp"
	"strings"
)

// Check is the answer of CheckInstall.
type Check struct {
	OK        bool
	Argv      []string
	Installer string
	Reason    string
}

// The cell builds layers for npm and pnpm only; the API's validator also
// knows pip, cargo and others, which a layer never installs.
var installers = map[string][]string{
	"npm":  {"install", "i", "add"},
	"pnpm": {"add", "install", "i"},
}

// Anything a shell would interpret. The argv is run without a shell, so none
// of these may appear (same set as cli-install.ts SHELL_META).
const shellMeta = ";&|<>`$\\(){}'\"\n\r\t*?!~#^"

var allowedFlags = map[string]bool{
	"-g": true, "--global": true, "--ignore-scripts": true, "--user": true,
	"--no-deps": true, "--only-binary=:all:": true, "--locked": true,
	"--force": true, "--quiet": true, "-q": true,
}

// The patterns run on an ASCII-lowercased token instead of using (?i): Go's
// case folding also matches U+017F and U+212A against s and k, which the
// JavaScript validator does not.
const (
	semver = `v?\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?`
	shaPin = `sha256:[a-f0-9]{64}`
)

var (
	atPinned    = regexp.MustCompile(`^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._/-]*@(?:` + semver + `|` + shaPin + `)$`)
	notRegistry = regexp.MustCompile(`://|^(?:git|hg|svn|bzr)\+|^file:|^[./~]`)
)

func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 'a' - 'A'
		}
	}
	return string(b)
}

// isJSSpace is JavaScript's \s, which the API splits and trims on; unicode.IsSpace
// differs (U+0085) and would make the two validators disagree.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// CheckInstall mirrors checkCliInstallCommand (libs/core/.../cli-install.ts)
// for the installers a layer uses. Shared fixtures hold both to the same
// answers: the cell never runs a string it cannot validate itself.
func CheckInstall(install string) Check {
	command := strings.TrimFunc(install, isJSSpace)
	if command == "" {
		return refuse("no install command")
	}
	if strings.ContainsAny(command, shellMeta) {
		return refuse("install command must be a single command without shell syntax")
	}
	argv := strings.FieldsFunc(command, isJSSpace)
	installer := argv[0]
	subs, ok := installers[installer]
	if !ok {
		return refuse("unsupported installer \"" + installer + "\" (use npm, pnpm)")
	}
	sub := ""
	if len(argv) > 1 {
		sub = argv[1]
	}
	if !contains(subs, sub) {
		return refuse("\"" + installer + " " + sub + "\" is not an install command")
	}
	var positional []string
	for _, token := range argv[2:] {
		if strings.HasPrefix(token, "-") {
			if !allowedFlags[token] {
				return refuse("install flag \"" + token + "\" is not allowed")
			}
			continue
		}
		positional = append(positional, token)
	}
	if len(positional) == 0 {
		return refuse("install command names no package")
	}
	for _, token := range positional {
		if notRegistry.MatchString(asciiLower(token)) {
			return refuse("\"" + token + "\" is not a registry package")
		}
	}
	var unpinned []string
	for _, token := range positional {
		if !atPinned.MatchString(asciiLower(token)) {
			unpinned = append(unpinned, token)
		}
	}
	if len(unpinned) > 0 {
		return refuse("every package must pin an exact version (unpinned: " + strings.Join(unpinned, ", ") + ")")
	}
	return Check{OK: true, Argv: argv, Installer: installer}
}

func refuse(reason string) Check { return Check{Reason: reason} }

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
