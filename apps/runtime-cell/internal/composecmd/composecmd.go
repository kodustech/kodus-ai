// Package composecmd is the docker compose command line the drivers run,
// as argv without the docker binary, and how its output reads. dockercli
// runs an argv on the host's docker; microvm joins it into one shell line
// for the guest agent (DockerLine). Nothing here runs a command.
package composecmd

import (
	"strconv"
	"strings"
	"time"
)

// Project is the compose project a command works on. Only Name is
// required; an empty field adds no flag.
type Project struct {
	Name    string
	Dir     string
	File    string
	EnvFile string
}

// Args is "compose -p <name>" and the project's flags.
func (p Project) Args() []string {
	args := []string{"compose", "-p", p.Name}
	if p.Dir != "" {
		args = append(args, "--project-directory", p.Dir)
	}
	if p.File != "" {
		args = append(args, "-f", p.File)
	}
	if p.EnvFile != "" {
		args = append(args, "--env-file", p.EnvFile)
	}
	return args
}

func (p Project) with(verb ...string) []string { return append(p.Args(), verb...) }

// UpPrebuilt brings the project up from images already there: no build,
// nothing orphaned, waiting for healthchecks (docker-gvisor, local-docker).
func (p Project) UpPrebuilt(services ...string) []string {
	return append(p.with("up", "-d", "--no-build", "--wait", "--remove-orphans"), services...)
}

// UpBuild builds the project's images and brings it up, waiting at most
// waitTimeoutSec for healthchecks (microvm: the VM's dockerd builds).
func (p Project) UpBuild(waitTimeoutSec int) []string {
	return p.with("up", "-d", "--build", "--wait", "--wait-timeout", strconv.Itoa(waitTimeoutSec), "--quiet-pull")
}

// Exec runs cmd in service with no TTY.
func (p Project) Exec(service string, cmd ...string) []string {
	return append(p.with("exec", "-T", service), cmd...)
}

// Ps lists every container of the project, stopped ones too, as JSON.
func Ps(project string) []string {
	return Project{Name: project}.with("ps", "-a", "--format", "json")
}

// LogsWindow is what service logged in [since, until], each line prefixed
// with the daemon's RFC 3339 timestamp, the last lines at most.
func LogsWindow(project, service string, since, until time.Time, lines int) []string {
	return Project{Name: project}.with("logs", "--no-color", "--no-log-prefix", "--timestamps",
		"--since", since.UTC().Format(time.RFC3339Nano), "--until", until.UTC().Format(time.RFC3339Nano),
		"--tail", strconv.Itoa(lines), service)
}

// Down takes the project down by its name alone, orphans too, and its
// volumes when volumes is set.
func Down(project string, volumes bool) []string {
	args := Project{Name: project}.with("down", "--remove-orphans")
	if volumes {
		args = append(args, "-v")
	}
	return args
}

// ShellQuote is s as one single-quoted POSIX shell word.
func ShellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// ShellJoin is words as one shell command line, each word quoted unless it
// is made only of characters the shell takes literally.
func ShellJoin(words ...string) string {
	quoted := make([]string, len(words))
	for i, w := range words {
		if plainWord(w) {
			quoted[i] = w
		} else {
			quoted[i] = ShellQuote(w)
		}
	}
	return strings.Join(quoted, " ")
}

// DockerLine is argv run by the docker binary, as one shell command line.
func DockerLine(argv []string) string { return ShellJoin(append([]string{"docker"}, argv...)...) }

func plainWord(w string) bool {
	if w == "" {
		return false
	}
	for _, r := range w {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case strings.ContainsRune("-_./:=,+@%", r):
		default:
			return false
		}
	}
	return true
}
