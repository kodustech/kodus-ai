package dockercli

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/claimlimits"
)

// DaemonEndpoint resolves the same environment/context precedence as Docker.
// An explicit DOCKER_CONTEXT overrides DOCKER_HOST; otherwise the selected
// context supplies the endpoint. This performs no daemon mutation or dial.
func (c CLI) DaemonEndpoint(ctx context.Context) (string, error) {
	selected := os.Getenv("DOCKER_CONTEXT")
	if selected == "" {
		if host := os.Getenv("DOCKER_HOST"); host != "" {
			return host, nil
		}
	}
	args := []string{"context", "inspect", "--format", "{{.Endpoints.docker.Host}}"}
	if selected != "" {
		args = append(args, "--", selected)
	}
	out, err := c.run(ctx, nil, args...)
	if err != nil {
		return "", err
	}
	endpoint := strings.TrimSpace(string(out))
	if endpoint == "" || strings.ContainsAny(endpoint, "\r\n") {
		return "", fmt.Errorf("dockercli: context did not return exactly one daemon endpoint")
	}
	return endpoint, nil
}

// ValidateCgroupParent accepts only an optional trusted cgroupfs path or generated slice
// supplied by the cell. It never normalizes an ambiguous host path.
func ValidateCgroupParent(parent string) error {
	if err := claimlimits.ValidateDockerParent(parent); err != nil {
		return fmt.Errorf("dockercli: %w", err)
	}
	return nil
}

// CgroupDaemonInfo reports the daemon's resource hierarchy and identity.
// These facts do not prove that a container actually joined that hierarchy;
// callers must also verify its PID against the host kernel before use.
type RuntimeInfo struct {
	Path        string   `json:"path"`
	RuntimeArgs []string `json:"runtimeArgs"`
}

type CgroupDaemonInfo struct {
	Version, Driver string
	ID, Name        string
	Rootless        bool
	Runtimes        map[string]RuntimeInfo
}

func (c CLI) CgroupInfo(ctx context.Context) (CgroupDaemonInfo, error) {
	out, err := c.run(ctx, nil, "info", "--format", "{{json .}}")
	if err != nil {
		return CgroupDaemonInfo{}, err
	}
	var raw struct {
		ID              string
		Name            string
		CgroupDriver    string
		CgroupVersion   string
		SecurityOptions []string
		Runtimes        map[string]RuntimeInfo
	}
	if err := json.Unmarshal(out, &raw); err != nil {
		return CgroupDaemonInfo{}, fmt.Errorf("dockercli: cgroup info: %w", err)
	}
	if raw.CgroupDriver == "" || raw.CgroupVersion == "" || raw.SecurityOptions == nil {
		return CgroupDaemonInfo{}, fmt.Errorf("dockercli: daemon omitted its cgroup driver, version or security options")
	}
	info := CgroupDaemonInfo{Version: raw.CgroupVersion, Driver: raw.CgroupDriver, ID: raw.ID, Name: raw.Name, Runtimes: raw.Runtimes}
	for _, option := range raw.SecurityOptions {
		for _, item := range strings.Split(option, ",") {
			if item == "name=rootless" {
				info.Rootless = true
			}
		}
	}
	return info, nil
}
