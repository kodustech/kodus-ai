package mirror

import (
	"bufio"
	"bytes"
	"regexp"
	"strings"
)

// MaxImagePins bounds what one checkout's Dockerfiles may pin.
const MaxImagePins = 200

var (
	argLine  = regexp.MustCompile(`(?i)^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)(?:=(\S*))?\s*$`)
	fromLine = regexp.MustCompile(`(?i)^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?\s*$`)
	argRef   = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)`)
)

// DockerHubPin is a Docker Hub image as the mirror pins it: repo:tag or
// repo@digest, with library/ for an official image. ok is false for an image
// of another registry, which the mirror does not serve.
func DockerHubPin(image string) (pin string, ok bool) {
	ref := strings.TrimSpace(image)
	if ref == "" || ref == "scratch" || strings.Contains(ref, "$") {
		return "", false
	}
	if first, rest, found := strings.Cut(ref, "/"); found && (strings.ContainsAny(first, ".:") || first == "localhost") {
		switch first {
		case "docker.io", "index.docker.io", "registry-1.docker.io":
			ref = rest
		default:
			return "", false
		}
	}
	name, digest, hasDigest := strings.Cut(ref, "@")
	tag := "latest"
	if i := strings.LastIndex(name, ":"); i > 0 && !strings.Contains(name[i:], "/") {
		name, tag = name[:i], name[i+1:]
	}
	if !strings.Contains(name, "/") {
		name = "library/" + name
	}
	if !ociName.MatchString(name) {
		return "", false
	}
	if hasDigest {
		if !IsDigest(digest) {
			return "", false
		}
		return name + "@" + digest, true
	}
	if !ociTag.MatchString(tag) {
		return "", false
	}
	return name + ":" + tag, true
}

// DockerfilePins are the Docker Hub images a Dockerfile's FROM lines name,
// with ARG defaults declared before them substituted. A FROM of an earlier
// stage, scratch, or an argument without a default pins nothing.
func DockerfilePins(data []byte) []string {
	args := map[string]string{}
	stages := map[string]bool{}
	var pins []string
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		if m := argLine.FindStringSubmatch(line); m != nil {
			if _, set := args[m[1]]; !set && m[2] != "" {
				args[m[1]] = strings.Trim(m[2], `"'`)
			}
			continue
		}
		m := fromLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		image := argRef.ReplaceAllStringFunc(m[1], func(s string) string {
			k := strings.Trim(s, "${}")
			if v, ok := args[k]; ok {
				return v
			}
			return s
		})
		if m[2] != "" {
			stages[strings.ToLower(m[2])] = true
		}
		if stages[strings.ToLower(image)] && image != m[2] {
			continue
		}
		if pin, ok := DockerHubPin(image); ok {
			pins = append(pins, pin)
		}
	}
	return pins
}

// PinRepo is the repository of a pin (repo:tag or repo@digest).
func PinRepo(pin string) string {
	if name, _, ok := strings.Cut(pin, "@"); ok {
		return name
	}
	if i := strings.LastIndex(pin, ":"); i > 0 {
		return pin[:i]
	}
	return pin
}
