package dockergvisor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/drivertest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
)

// requestDocker is memDocker with compose standing in: config prints the
// cell's rendered file back as JSON, as compose does, and up starts one
// container of the project on the claim network and prints a line. It keeps
// each project's rendered file for the checks.
type requestDocker struct {
	*memDocker
	rendered map[string]string   // project -> the rendered compose file
	mounts   map[string][]string // holder -> its read-only binds
	killed   map[string][]string // project -> the services sent the flush signal
}

func (c *requestDocker) ComposeKill(_ context.Context, project, signal string, services ...string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if signal == coverageFlushSignal {
		c.killed[project] = append(c.killed[project], services...)
	}
	return nil
}

func (c *requestDocker) RunHolder(ctx context.Context, h dockercli.HolderSpec) (dockercli.Container, error) {
	c.mu.Lock()
	c.mounts[h.Name] = h.Mounts
	c.mu.Unlock()
	return c.memDocker.RunHolder(ctx, h)
}

// RunSandbox makes a code sandbox as a holder with the sandbox's binds.
func (c *requestDocker) RunSandbox(ctx context.Context, s dockercli.SandboxSpec) (dockercli.Container, error) {
	return c.RunHolder(ctx, s.HolderSpec)
}

func (c *requestDocker) ExecStream(context.Context, string, string, ...string) (io.ReadWriteCloser, error) {
	return nil, errors.New("no guest agent in memory")
}

func (c *requestDocker) ComposeConfig(_ context.Context, p dockercli.ComposeProject) ([]byte, error) {
	raw, err := os.ReadFile(p.File)
	if err != nil {
		return nil, err
	}
	var doc map[string]any
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	c.mu.Lock()
	c.rendered[p.Name] = string(raw)
	c.mu.Unlock()
	return json.Marshal(doc)
}

func (c *requestDocker) ComposeUp(ctx context.Context, p dockercli.ComposeProject) error {
	if sink := dockercli.OutputFrom(ctx); sink != nil {
		sink(" Container " + p.Name + "-app-1  Started")
	}
	raw, _ := os.ReadFile(p.File)
	c.mu.Lock()
	c.rendered[p.Name] = string(raw)
	c.mu.Unlock()
	claim := strings.TrimSuffix(strings.TrimPrefix(p.Name, "kodus-"), "-workload")
	c.plant(dockercli.Container{
		ID: "c-" + p.Name, Name: p.Name + "-app-1",
		Labels:   map[string]string{"com.docker.compose.project": p.Name, dockercli.LabelFromTag(driver.TagCell): "cell-1"},
		Networks: map[string]string{networkName(claim): "10.213.0.20"},
	})
	return nil
}

// The docker-gvisor driver honors every field of its requests, as its
// in-memory Docker shows them.
func TestTheDockerGVisorDriverHonorsItsRequests(t *testing.T) {
	drivertest.RunRequests(t, func(t *testing.T) drivertest.RequestSubject {
		docker := &requestDocker{memDocker: newMemDocker(), rendered: map[string]string{}, mounts: map[string][]string{}, killed: map[string][]string{}}
		docker.plant(dockercli.Container{ID: "cegress", Name: "kodus-egress", Networks: map[string]string{"kodus-cell": "10.9.0.2"}})
		trust := t.TempDir()
		files := machinetrust.Files{Bundle: filepath.Join(trust, "ca-bundle.pem"), CellCA: filepath.Join(trust, "cell-ca.pem")}
		_ = os.WriteFile(files.Bundle, []byte("bundle"), 0o644)
		_ = os.WriteFile(files.CellCA, []byte("cellca"), 0o644)
		d, err := New(context.Background(), docker, Config{
			CellID: "cell-1", HolderImage: "kodus/holder@sha256:abc", SandboxImage: "kodus/sandbox@sha256:def", WorkDir: t.TempDir(), EgressContainer: "kodus-egress",
			BuilderImage: "kodus-runtime-builder@sha256:abc", BuilderTrustsCellCA: true, Trust: files,
		})
		if err != nil {
			t.Fatal(err)
		}
		recordChowns(d)
		n := 0
		claim := func(t *testing.T) (string, driver.ClaimNetwork) {
			t.Helper()
			n++
			id := fmt.Sprintf("req-%d", n)
			net, err := d.PrepareClaim(context.Background(), driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: id})
			if err != nil {
				t.Fatal(err)
			}
			return id, net
		}
		newSpec := func(t *testing.T) driver.MachineSpec {
			id, net := claim(t)
			s := drivertest.BaseSpec("cell-1", id, net)
			s.ExpiresAt, s.HardExpiresAt = time.Now().Add(10*time.Minute), time.Now().Add(time.Hour)
			return s
		}
		return drivertest.RequestSubject{
			Capabilities: d.Capabilities(),
			Booter:       d,
			Flusher:      d,
			Flushed: func(t *testing.T, ref driver.MachineRef) []string {
				docker.mu.Lock()
				defer docker.mu.Unlock()
				return docker.killed[ref.MachineID]
			},
			Prepare: func(t *testing.T, ask driver.UpRequest) driver.UpRequest {
				ref, err := d.Create(context.Background(), newSpec(t))
				if err != nil {
					t.Fatal(err)
				}
				ws := filepath.Join(t.TempDir(), "ws")
				if err := os.MkdirAll(filepath.Join(ws, "app"), 0o755); err != nil {
					t.Fatal(err)
				}
				_ = os.WriteFile(filepath.Join(ws, "app", "Dockerfile"), []byte("FROM x\nRUN --mount=type=secret,id="+drivertest.BuildSecretName+" true\n"), 0o644)
				ask.Ref, ask.Compose, ask.ProjectDir, ask.WorkspaceRoot = ref, []byte("services:\n  app:\n    build: .\n"), filepath.Join(ws, "app"), ws
				return ask
			},
			Booted: func(t *testing.T, ref driver.MachineRef) drivertest.Booted {
				docker.mu.Lock()
				file := docker.rendered[ref.MachineID]
				var secrets bool
				for _, b := range docker.builds {
					if strings.Contains(b.Tag, ref.MachineID) && len(b.Secrets) > 0 {
						secrets = true
					}
				}
				docker.mu.Unlock()
				var got drivertest.Booted
				got.Trusted = strings.Contains(file, files.Bundle) && strings.Contains(file, machinetrust.BundleTarget)
				if decoy := decoyPath(d.workDir(), ref.MachineID); strings.Contains(file, decoy) {
					b, _ := os.ReadFile(decoy)
					got.Decoy = string(b)
				}
				got.BuildSecrets = secrets
				got.Coverage = renderedCoverage(t, file)
				return got
			},
			Sandboxer:   d,
			SandboxSpec: newSpec,
			SandboxTrusted: func(t *testing.T, ref driver.MachineRef) bool {
				docker.mu.Lock()
				defer docker.mu.Unlock()
				return strings.Contains(strings.Join(docker.mounts[ref.MachineID], " "), files.Bundle+":"+machinetrust.BundleTarget)
			},
		}
	})
}

// renderedCoverage: the rendered file binds a directory writable at the
// coverage target and a file read-only at the preload's, on the prepared
// service.
func renderedCoverage(t *testing.T, file string) bool {
	t.Helper()
	var doc struct {
		Services map[string]struct {
			Volumes []map[string]any `yaml:"volumes"`
		} `yaml:"services"`
	}
	if err := yaml.Unmarshal([]byte(file), &doc); err != nil {
		t.Fatal(err)
	}
	var dir, preload bool
	for _, v := range doc.Services[drivertest.PreparedService].Volumes {
		ro, _ := v["read_only"].(bool)
		switch {
		case v["type"] == "bind" && v["target"] == sandbox.CoverageTarget && !ro && v["source"] != "":
			dir = true
		case v["type"] == "bind" && v["target"] == sandbox.CoveragePreloadTarget && ro && v["source"] != "":
			preload = true
		}
	}
	return dir && preload
}
