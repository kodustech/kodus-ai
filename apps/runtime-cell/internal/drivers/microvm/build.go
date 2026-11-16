package microvm

import (
	"fmt"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/buildmirror"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/composecmd"
)

// An environment VM builds its project with compose. When the claim's
// machines trust the cell CA (driver.UpRequest.CellTrust), the cell inspects
// the VM's TLS to registries at the injector, so the builds' RUN steps must
// trust that CA too, as the gVisor builder's do: the VM dockerd's own
// BuildKit is stock, and its RUN steps keep their base image's trust store
// (a bun or pnpm install then fails on the injector's leaf). Such a claim
// builds with the kit's buildkitd instead, the cell builder's
// (builder-image/exec-ca-bundle.patch): one the cell starts in the VM with
// the bundle as execCABundle and the mirror as docker.io's registry, which
// compose reaches through a buildx builder of the remote driver. Its state
// is on the data disk, so a bake's template keeps the build cache for the
// PR's build, as the VM dockerd's does.

const (
	// vmBuilderName is the buildx builder compose builds with.
	vmBuilderName = "kodus"
	// vmBuilderVersionMark is in the version of the cell's buildkitd only
	// (builder-image/Dockerfile: v<release>-kodus.<revision>).
	vmBuilderVersionMark = "-kodus."
	// vmBuilderConfigFile is the builder's buildkitd.toml among the cell's
	// files of the project (cellFilesDir), next to the trust bundle.
	vmBuilderConfigFile = "buildkitd.toml"
)

// vmBuilder is the VM builder's paths in the VM, under its data mount
// (guestinit.DataMount): its configuration, bundle, log and socket in one
// directory, its state in another.
type vmBuilder struct {
	data string
	// system is the VM's own trust store (vmSystemBundle when empty).
	system string
}

func (b vmBuilder) dir() string    { return b.data + "/kodus-buildkit" }
func (b vmBuilder) root() string   { return b.data + "/buildkit" }
func (b vmBuilder) sock() string   { return "unix://" + b.dir() + "/buildkitd.sock" }
func (b vmBuilder) bundle() string { return b.dir() + "/ca-bundle.pem" }
func (b vmBuilder) conf() string   { return b.dir() + "/" + vmBuilderConfigFile }
func (b vmBuilder) log() string    { return b.dir() + "/buildkitd.log" }

// config is the builder's buildkitd.toml: the OCI worker only, every RUN
// given the bundle, and docker.io pulled through the mirror when the cell
// serves one.
func (b vmBuilder) config(mirror buildmirror.Mirror) ([]byte, error) {
	conf := fmt.Sprintf("root = %q\n\n[grpc]\n  address = [%q]\n\n[worker.containerd]\n  enabled = false\n\n[worker.oci]\n  enabled = true\n  execCABundle = %q\n",
		b.root(), b.sock(), b.bundle())
	if mirror.Registry != "" {
		reg, err := buildmirror.RegistryConfig(mirror.Registry)
		if err != nil {
			return nil, err
		}
		conf += "\n" + string(reg)
	}
	return []byte(conf), nil
}

// script readies the builder in the VM: it refuses a kit whose buildkitd is
// not the cell's (exit 97), copies the configuration and the bundle from the
// project's cell files (so a restored VM's builder reads this claim's
// bundle), starts buildkitd unless it already answers (a VM restored from a
// template still runs the one its setup started), waits for it (exit 98 with
// its log's tail) and makes the buildx builder once. buildkitd leaves the
// command's session (setsid), so it outlives the exec, and reads the
// registries' TLS with the bundle too (SSL_CERT_FILE).
func (b vmBuilder) script() string {
	q := composecmd.ShellQuote
	sock, log := q(b.sock()), q(b.log())
	return strings.Join([]string{
		"set -e",
		"if ! buildkitd --version 2>/dev/null | grep -q -- " + q(vmBuilderVersionMark) + "; then echo 'microvm: the environment root has no Kodus BuildKit; rebuild the microVM kit' >&2; exit 97; fi",
		"mkdir -p " + q(b.dir()) + " " + q(b.root()),
		"cp " + q(cellFilesDir+"/"+vmBuilderConfigFile) + " " + q(b.conf()),
		"cp " + q(cellFilesDir+"/ca-bundle.pem") + " " + q(b.bundle()+".new") + " && mv " + q(b.bundle()+".new") + " " + q(b.bundle()),
		"if ! buildctl --addr " + sock + " debug workers >/dev/null 2>&1; then",
		"  SSL_CERT_FILE=" + q(b.bundle()) + " setsid buildkitd --config " + q(b.conf()) + " >" + log + " 2>&1 </dev/null &",
		"  i=0; until buildctl --addr " + sock + " debug workers >/dev/null 2>&1; do i=$((i+1)); if [ \"$i\" -ge 300 ]; then echo \"microvm: the VM's BuildKit did not start: $(tail -c 2000 " + log + ")\" >&2; exit 98; fi; sleep 0.1; done",
		"fi",
		"docker buildx inspect " + q(vmBuilderName) + " >/dev/null 2>&1 || docker buildx create --name " + q(vmBuilderName) + " --driver remote " + sock + " >/dev/null",
	}, "\n")
}

// vmSystemBundle is the VM's own trust store: what its dockerd, the docker
// CLI (buildx's token fetch), git and curl read.
const vmSystemBundle = "/etc/ssl/certs/ca-certificates.crt"

// systemTrust adds the cell CA to the VM's own trust store, once: a claim
// that trusts the cell CA is an inspect source as a whole VM, so the VM
// dockerd's pulls and buildx's registry token fetch reach the injector too,
// not only the services and the builds' RUN steps. A Go program reads the
// store once, at its first TLS: this runs before compose's first pull, and
// a template's VM keeps the CA its setup added.
func (b vmBuilder) systemTrust() string {
	q := composecmd.ShellQuote
	store := q(vmSystemBundle)
	if b.system != "" {
		store = q(b.system)
	}
	ca := q(cellFilesDir + "/cell-ca.pem")
	return "grep -qF -- \"$(sed -n 2p " + ca + ")\" " + store + " || { printf '\\n' >> " + store + " && cat " + ca + " >> " + store + "; }"
}

// upCommand is what Up runs in the VM for the claim's project: compose's
// build and up with the VM dockerd's BuildKit; for a claim that trusts the
// cell CA, the VM's own trust store given the CA first (systemTrust), and,
// with withBuilder, the builder readied, the images built with it, then the
// project up from them. prebuilt: the project was built from this file
// already, and comes up from those images, building nothing.
func (b vmBuilder) upCommand(project string, trusted, withBuilder, prebuilt bool) string {
	p := composecmd.Project{Name: project, File: composeFileName}
	var lines []string
	if trusted {
		lines = append(lines, "set -e", b.systemTrust())
	}
	if prebuilt {
		return strings.Join(append(lines, composecmd.DockerLine(p.UpBuilt(540))), "\n")
	}
	if !withBuilder {
		return strings.Join(append(lines, composecmd.DockerLine(p.UpBuild(540))), "\n")
	}
	return strings.Join(append(lines, b.script(), composecmd.DockerLine(p.BuildWith(vmBuilderName)), composecmd.DockerLine(p.UpBuilt(540))), "\n")
}
