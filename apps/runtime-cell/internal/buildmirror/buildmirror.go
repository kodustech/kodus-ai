// Package buildmirror is what an image build gets from the cell's read-only
// mirror, whichever driver runs the build (G1): the build args that send each
// package manager to the mirror, under the names the shared list gives
// (netguard.MirrorBuildArgNames), and BuildKit's registry configuration that
// pulls docker.io images through it. docker-gvisor hands both to its builder
// container; microvm writes them into the environment VM's compose file and
// its BuildKit configuration.
package buildmirror

import (
	"fmt"
	"maps"
	"net"
	"net/url"
	"regexp"
	"strings"
)

// Mirror is the cell's mirror as a build reaches it. An empty field is a
// mirror the cell does not serve.
type Mirror struct {
	// GoProxy is the GOPROXY every build gets ("…/go,off").
	GoProxy string
	// NPM and PyPI are the npm registry ("…/npm/") and the PyPI simple
	// index ("…/pypi/simple/").
	NPM, PyPI string
	// Artifacts is the root of the known read-only artifacts ("…/artifacts/").
	Artifacts string
	// Registry is the registry mirror (host:port) BuildKit pulls docker.io
	// images through.
	Registry string
}

// At is the mirror served at base, the URL the machines name it by
// (http://mirror.cell.internal:8080): its Go proxy, npm registry, PyPI index
// and registry under the paths cmd/egress serves them at. Empty base: no
// mirror.
func At(base string) (Mirror, error) {
	if base == "" {
		return Mirror{}, nil
	}
	u, err := url.Parse(base)
	if err != nil || u.Scheme != "http" || u.Host == "" || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return Mirror{}, fmt.Errorf("buildmirror: %q is not http://<host>:<port>", base)
	}
	if _, port, err := net.SplitHostPort(u.Host); err != nil || port == "" {
		return Mirror{}, fmt.Errorf("buildmirror: %q names no port", base)
	}
	root := "http://" + u.Host
	m := Mirror{GoProxy: root + "/go,off", NPM: root + "/npm/", PyPI: root + "/pypi/simple/", Artifacts: root + "/artifacts/", Registry: u.Host}
	if !hostPort.MatchString(m.Registry) {
		return Mirror{}, fmt.Errorf("buildmirror: registry %q is not host:port", m.Registry)
	}
	return m, nil
}

// Args are a build's args with the mirror's addresses added (GOPROXY; npm,
// pnpm and Yarn Berry's registry; pip and uv's index, with HTTP allowed for
// the mirror's host): a Dockerfile that declares the ARG reaches its
// registry only through the read-only mirror. The project's own value of
// each wins, and an index it set itself keeps its own trusted host. Every
// build gets CI=true, so the args are never nil.
func (m Mirror) Args(project map[string]string) map[string]string {
	args := maps.Clone(project)
	set := func(k, v string) {
		if v == "" {
			return
		}
		if args == nil {
			args = map[string]string{}
		}
		if _, ok := args[k]; !ok {
			args[k] = v
		}
	}
	// The Runtime builds like CI: GitHub Actions always sets CI=true, and
	// tools change behavior on it. Whatever the mirror serves, and the
	// project's own value wins.
	set("CI", "true")
	set("GOPROXY", m.GoProxy)
	if m.NPM != "" {
		host := hostOf(m.NPM)
		_, own := args["YARN_NPM_REGISTRY_SERVER"]
		set("npm_config_registry", m.NPM)
		set("pnpm_config_registry", m.NPM)
		set("YARN_NPM_REGISTRY_SERVER", strings.TrimSuffix(m.NPM, "/"))
		if !own {
			set("YARN_UNSAFE_HTTP_WHITELIST", host)
		}
	}
	if m.PyPI != "" {
		host := hostOf(m.PyPI)
		_, ownPip := args["PIP_INDEX_URL"]
		_, ownUV := args["UV_DEFAULT_INDEX"]
		set("PIP_INDEX_URL", m.PyPI)
		set("UV_DEFAULT_INDEX", m.PyPI)
		if !ownPip {
			set("PIP_TRUSTED_HOST", host)
		}
		if !ownUV {
			set("UV_INSECURE_HOST", host)
		}
	}
	if m.Artifacts != "" {
		// Prisma appends /all_commits/<engine>/<platform>/<file> to its
		// mirror, mongodb-memory-server /linux/<file>: the entries of
		// mirror.DefaultArtifacts. A project's own value wins.
		set("PRISMA_ENGINES_MIRROR", m.Artifacts+"prisma")
		set("MONGOMS_DOWNLOAD_MIRROR", m.Artifacts+"mongodb")
		// mongodb-memory-server builds its URL with https unless told otherwise,
		// whatever the mirror's scheme; the cell's mirror is plain HTTP.
		set("MONGOMS_USE_HTTP", "1")
		// firebase-tools has no download-URL override: a Dockerfile fetches
		// the emulators it names from here (the mirror's firebase-emulators
		// entry) into the cache firebase-tools reads (docs/runtime/egress-allowlist.md §17).
		set("FIREBASE_EMULATORS_MIRROR", m.Artifacts+"firebase-emulators")
	}
	return args
}

var hostPort = regexp.MustCompile(`^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?:[0-9]{1,5}$`)

// RegistryConfig is buildkitd.toml's part that pulls docker.io through the
// registry mirror at hostPort, which serves plain HTTP on the claim's
// network.
func RegistryConfig(hostPort string) ([]byte, error) {
	if !validHostPort(hostPort) {
		return nil, fmt.Errorf("buildmirror: registry mirror %q is not host:port", hostPort)
	}
	return []byte(fmt.Sprintf("[registry.\"docker.io\"]\n  mirrors = [%q]\n\n[registry.%q]\n  http = true\n", hostPort, hostPort)), nil
}

func validHostPort(s string) bool { return hostPort.MatchString(s) }

func hostOf(raw string) string {
	if u, err := url.Parse(raw); err == nil {
		return u.Hostname()
	}
	return ""
}
