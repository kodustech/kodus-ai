package sandbox

import (
	"fmt"
	"io"
	"os"
	"path"
	"regexp"
	"strings"
)

// A build gets only the org secrets it asks for (G6,
// docs/runtime/egress-allowlist.md §16): those its compose build section
// lists under secrets, and those its Dockerfile mounts (RUN
// --mount=type=secret,id=<id>). A build that asks for none gets none.
//
// Build.Secrets maps each BuildKit secret id the build may read to the org
// secret that holds its placeholder:
//
//   - build.secrets: [NPM_TOKEN] asks for the org secret NPM_TOKEN under the
//     id NPM_TOKEN;
//   - build.secrets: [{source: npm, target: NPM_AUTH}] asks for the secret
//     the top-level entry npm names, under the id NPM_AUTH (compose: target
//     is the id the Dockerfile reads, source by default);
//   - a top-level entry secrets: {npm: {environment: NPM_TOKEN}} names the
//     org secret NPM_TOKEN; a source with no top-level entry names the org
//     secret of its own name. Any other source (file, external, content)
//     brings in the host and is refused;
//   - a Dockerfile's RUN --mount=type=secret,id=NPM_TOKEN asks for the org
//     secret NPM_TOKEN, unless the compose file maps that id itself.
//
// Asking for a secret the claim does not have gives nothing: BuildKit then
// skips the mount, or fails the step that marked it required.

// maxDockerfileScan bounds how much of a Dockerfile is read for its secret
// mounts; a Dockerfile past it is read up to it.
const maxDockerfileScan = 1 << 20

// secretMount finds a RUN --mount flag's value, quoted or not.
var secretMount = regexp.MustCompile(`--mount=("[^"]*"|'[^']*'|\S+)`)

// topSecrets reads the compose file's top-level secrets: each entry name to
// the org secret its environment source names. Only that source is taken.
func (c *checker) topSecrets(v any) map[string]string {
	out := map[string]string{}
	switch x := v.(type) {
	case nil:
	case map[string]any:
		for _, name := range sortedKeys(x) {
			p := "secrets." + name
			entry, _ := x[name].(map[string]any)
			env, _ := entry["environment"].(string)
			if len(entry) != 1 || env == "" {
				c.add(p, "a secret comes from the org's secrets: only environment: <NAME> names one")
				continue
			}
			if !argName.MatchString(env) {
				c.add(p+".environment", "not a secret name")
				continue
			}
			out[name] = env
		}
	default:
		c.add("secrets", "not a mapping")
	}
	return out
}

// buildSecrets reads a build section's secrets into into, id to org secret.
func (c *checker) buildSecrets(p string, v any, top map[string]string, into map[string]string) {
	add := func(at, source, id string) {
		if !argName.MatchString(source) && top[source] == "" {
			c.add(at, fmt.Sprintf("%q is not a secret name", source))
			return
		}
		if !argName.MatchString(id) {
			c.add(at, fmt.Sprintf("id %q is not a secret name", id))
			return
		}
		secret := source
		if env := top[source]; env != "" {
			secret = env
		}
		into[id] = secret
	}
	switch x := v.(type) {
	case nil:
	case []any:
		for i, item := range x {
			at := fmt.Sprintf("%s[%d]", p, i)
			switch s := item.(type) {
			case string:
				add(at, s, s)
			case map[string]any:
				for _, k := range sortedKeys(s) {
					if k != "source" && k != "target" {
						c.add(at+"."+k, "only source and target")
					}
				}
				source, _ := s["source"].(string)
				id, _ := s["target"].(string)
				if id == "" {
					id = source
				}
				add(at, source, id)
			default:
				c.add(at, "neither a name nor a mapping")
			}
		}
	default:
		c.add(p, "not a list")
	}
}

// dockerfileSecrets adds the ids file mounts as secrets to into, each to
// the org secret of its name, unless into maps that id already.
func dockerfileSecrets(file string, into map[string]string) error {
	f, err := os.Open(file) //nolint:gosec // G304: the build's Dockerfile, resolved inside the checkout
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	text, err := io.ReadAll(io.LimitReader(f, maxDockerfileScan))
	if err != nil {
		return err
	}
	for _, id := range DockerfileSecretIDs(string(text)) {
		if _, ok := into[id]; !ok {
			into[id] = id
		}
	}
	return nil
}

// DockerfileSecretIDs are the BuildKit secret ids a Dockerfile's RUN
// --mount=type=secret flags read: the id, else the target's base name (the
// Dockerfile reference's default), else the env name. An id that is not an
// env var name (an interpolated one included) is left out: no org secret
// has it. A mention in a comment counts as asking.
func DockerfileSecretIDs(text string) []string {
	seen := map[string]bool{}
	var out []string
	for _, m := range secretMount.FindAllStringSubmatch(text, -1) {
		opts := map[string]string{}
		for _, field := range strings.Split(unquote(m[1]), ",") {
			k, v, _ := strings.Cut(unquote(strings.TrimSpace(field)), "=")
			opts[strings.ToLower(k)] = v
		}
		if opts["type"] != "secret" {
			continue
		}
		id := opts["id"]
		if id == "" {
			for _, k := range []string{"target", "dst", "destination"} {
				if t := opts[k]; t != "" {
					id = path.Base(t)
					break
				}
			}
		}
		if id == "" {
			id = opts["env"]
		}
		if argName.MatchString(id) && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

func unquote(s string) string {
	if len(s) >= 2 && (s[0] == '"' || s[0] == '\'') && s[len(s)-1] == s[0] {
		return s[1 : len(s)-1]
	}
	return s
}
