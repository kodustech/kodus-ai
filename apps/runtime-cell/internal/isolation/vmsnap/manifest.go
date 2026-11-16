package vmsnap

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
)

// Schema is the manifest's version; a manifest of another is refused.
const Schema = 1

// The files of a snapshot, by their name in its directory.
const (
	FileState = "vmstate"
	FileMem   = "mem"
	// FileRoot and FileData are an environment's writable disks as they
	// were when its memory was saved; a sandbox's read-only root is the
	// kit's base (Manifest.RootBase) and is not kept.
	FileRoot = "rootfs.ext4"
	FileData = "data.ext4"
)

// File is one snapshot file as it was written.
type File struct {
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	// ModUnixNano is its modification time once published: a file changed
	// since is refused without reading it.
	ModUnixNano int64 `json:"modUnixNano"`
}

// Manifest is what a snapshot is: written last, so a directory without one
// is a snapshot that never finished.
type Manifest struct {
	Schema  int             `json:"schema"`
	ID      string          `json:"id"`
	Org     string          `json:"org"`
	Purpose Purpose         `json:"purpose"`
	Shape   isolation.Shape `json:"shape"`
	Created time.Time       `json:"created"`
	// Source is the machine it was taken of (for the audit).
	Source   string `json:"source"`
	MemoryMB int    `json:"memoryMb"`
	VCPUs    int    `json:"vcpus"`
	// Kit is the digest of the microVM kit the source ran on: the guest
	// kernel in the memory file is that kit's, so a new kit retires it.
	Kit string `json:"kit"`
	// Host is the host's fingerprint (HostFingerprint): Firecracker
	// restores only on the hardware and software it saved on.
	Host string `json:"host"`
	// RootBase is the sha256 of the kit's base a sandbox's read-only root
	// is a clone of.
	RootBase string `json:"rootBase,omitempty"`
	// Key is a template's key in its org; Claim a round's claim.
	Key   string `json:"key,omitempty"`
	Claim string `json:"claim,omitempty"`
	// Network: the machine had eth0, so a restore needs a tap for it.
	Network bool            `json:"network,omitempty"`
	Files   map[string]File `json:"files"`
}

var idRE = regexp.MustCompile(`^ksn-[0-9a-f]{32}$`)

// ValidID reports whether id is a snapshot id this package makes.
func ValidID(id string) bool { return idRE.MatchString(id) }

// filesOf are the files a snapshot of shape holds.
func filesOf(shape isolation.Shape) []string {
	if shape == isolation.ShapeEnvironment {
		return []string{FileState, FileMem, FileRoot, FileData}
	}
	return []string{FileState, FileMem}
}

// Check refuses a manifest that is not one this package writes for org and
// id: its schema, ids, purpose, shape, sizes and its exact set of files.
func (m Manifest) Check(org, id string) error {
	switch {
	case m.Schema != Schema:
		return refuse("snapshot schema %d", m.Schema)
	case !ValidID(m.ID) || m.ID != id:
		return refuse("snapshot %q is not %q", m.ID, id)
	case m.Org == "" || m.Org != org:
		return refuse("snapshot %s is not of org %q", id, org)
	case m.Purpose != isolation.PurposeTemplate && m.Purpose != isolation.PurposeSession && m.Purpose != isolation.PurposeRound:
		return refuse("snapshot purpose %q", m.Purpose)
	case m.Purpose == isolation.PurposeRound && m.Claim == "":
		return refuse("round snapshot %s names no claim", id)
	case m.Purpose != isolation.PurposeTemplate && m.Key != "":
		return refuse("only a template has a key (snapshot %s)", id)
	case m.Shape != isolation.ShapeSandbox && m.Shape != isolation.ShapeEnvironment:
		return refuse("snapshot shape %q", m.Shape)
	case m.MemoryMB < 128 || m.VCPUs < 1 || m.Kit == "" || m.Host == "":
		return refuse("snapshot %s lacks its machine, kit or host", id)
	case m.Shape == isolation.ShapeSandbox && m.RootBase == "":
		return refuse("sandbox snapshot %s names no root base", id)
	}
	want := filesOf(m.Shape)
	if len(m.Files) != len(want) {
		return refuse("snapshot %s holds %d files, its shape %d", id, len(m.Files), len(want))
	}
	for _, name := range want {
		f, ok := m.Files[name]
		if !ok || f.Size <= 0 || (len(f.SHA256) != 64 && !(unhashed(m.Purpose, name) && f.SHA256 == "")) {
			return refuse("snapshot %s: file %s", id, name)
		}
	}
	if f := m.Files[FileMem]; f.Size != int64(m.MemoryMB)<<20 {
		return refuse("snapshot %s: a %d-byte memory file for %d MiB", id, f.Size, m.MemoryMB)
	}
	return nil
}

// Here is what a host restores with: the kit it runs and its fingerprint.
type Here struct {
	Kit  string
	Host string
	// Bases are the sha256 of the kit's root bases on this host.
	Bases []string
}

// Restorable says whether this host can restore m into a machine of shape.
func (m Manifest) Restorable(h Here, shape isolation.Shape) error {
	switch {
	case m.Shape != shape:
		return refuse("snapshot %s is of a %s, not a %s", m.ID, m.Shape, shape)
	case m.Kit != h.Kit:
		return refuse("snapshot %s was taken on kit %s, this cell runs %s", m.ID, m.Kit, h.Kit)
	case m.Host != h.Host:
		return refuse("snapshot %s was taken on another host (%s, this one %s)", m.ID, short(m.Host), short(h.Host))
	case m.Shape == isolation.ShapeSandbox && !slices.Contains(h.Bases, m.RootBase):
		return refuse("snapshot %s's root base is not in this cell's kit", m.ID)
	}
	return nil
}

func short(s string) string {
	if len(s) > 12 {
		return s[:12]
	}
	return s
}

// HostFingerprint is what Firecracker needs to be the same between the save
// and the restore of a snapshot ("Where can I resume my snapshots?",
// docs/snapshotting/snapshot-support.md): the CPU (vendor, family, model,
// stepping, microcode and flags of the first processor in cpuinfo), the
// host kernel's release and the VMM binary.
func HostFingerprint(cpuinfo []byte, kernelRelease, firecrackerSHA string) string {
	keep := map[string]string{}
	sc := bufio.NewScanner(bytes.NewReader(cpuinfo))
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		if strings.TrimSpace(line) == "" && len(keep) > 0 {
			break // the first processor only
		}
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		switch k {
		case "vendor_id", "cpu family", "model", "model name", "stepping", "microcode", "flags", "CPU implementer", "CPU part", "CPU variant", "CPU revision", "Features":
			keep[k] = v
		}
	}
	keys := make([]string, 0, len(keep))
	for k := range keep {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	h := sha256.New()
	for _, k := range keys {
		_, _ = fmt.Fprintf(h, "%s=%s\n", k, keep[k])
	}
	_, _ = fmt.Fprintf(h, "kernel=%s\nfirecracker=%s\n", kernelRelease, firecrackerSHA)
	return hex.EncodeToString(h.Sum(nil))
}

func encodeManifest(m Manifest) ([]byte, error) { return json.MarshalIndent(m, "", "  ") }

func decodeManifest(raw []byte) (Manifest, error) {
	var m Manifest
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&m); err != nil {
		return Manifest{}, refuse("snapshot manifest: %v", err)
	}
	return m, nil
}

// unhashed says a file of a snapshot of purpose is published with no
// digest: a round's memory file and disks (Store.Publish). Its state file,
// and every file of a template or a session, always has one.
func unhashed(purpose Purpose, name string) bool {
	return purpose == isolation.PurposeRound && name != FileState
}
