// systemdproof is an explicitly invoked fixture: two tiny runsc scopes share a native claim budget.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/claimlimits"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	id := flag.String("id", "", "owned UUID")
	socket := flag.String("socket", "", "private Docker Unix socket")
	flag.Parse()
	root := "/var/lib/kodus-runtime-harness/" + *id
	if !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(*id) || *socket != "unix://"+root+"/run/docker.sock" {
		return fmt.Errorf("owned UUID/socket required")
	}
	owner, err := os.ReadFile(root + "/owner")
	if err != nil || strings.TrimSpace(string(owner)) != *id {
		return fmt.Errorf("VM ownership marker mismatch")
	}
	cell := "integrated-" + *id
	slice := claimlimits.RootSliceName(cell)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	manager, err := claimlimits.NewSystemd(context.Background(), slice, cell)
	if err != nil {
		return err
	}
	defer manager.Close()
	if err = manager.PruneEmpty(); err != nil {
		return err
	}
	if err = manager.RequireEmpty(); err != nil {
		return err
	}
	sum := sha256.Sum256([]byte("native-proof:" + *id))
	key := hex.EncodeToString(sum[:])
	limits := claimlimits.Limits{MemoryBytes: 256 * 1024 * 1024, CPUQuota: 50000, CPUPeriod: 100000, Pids: 256}
	parent, err := manager.Ensure(key, limits)
	if err != nil {
		name := strings.TrimSuffix(slice, ".slice") + "-" + key + ".slice"
		detail, _ := exec.CommandContext(ctx, "systemctl", "show", name, "-p", "Id,Description,Slice,ControlGroup,ActiveState,Transient,Delegate,StopWhenUnneeded,CPUAccounting,MemoryAccounting,TasksAccounting,MemoryMax,MemorySwapMax,TasksMax,CPUQuotaPerSecUSec,CPUQuotaPeriodUSec").CombinedOutput()
		return fmt.Errorf("%w\nactual unit:\n%s", err, detail)
	}
	docker := func(args ...string) (string, error) {
		cmd := exec.CommandContext(ctx, "docker", append([]string{"--host", *socket}, args...)...)
		b, e := cmd.CombinedOutput()
		if e != nil {
			return "", fmt.Errorf("docker %s: %w: %s", args[0], e, b)
		}
		return strings.TrimSpace(string(b)), nil
	}
	names := []string{"krint-" + *id + "-native-a", "krint-" + *id + "-native-b"}
	cleaned := false
	defer func() {
		if !cleaned {
			if e := cleanupNativeContainers(*socket, names, *id, parent); e != nil {
				fmt.Fprintln(os.Stderr, "owned native cleanup:", e)
			}
			if e := manager.Remove(key); e != nil {
				fmt.Fprintln(os.Stderr, "owned native slice cleanup:", e)
			}
		}
	}()
	pids := []int{}
	members := []string{}
	for _, name := range names {
		if _, err = docker("run", "-d", "--name", name, "--label", "kodus.integrated="+*id, "--runtime", "runsc", "--cgroup-parent", parent, "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "alpine:3.20", "sh", "-c", "while :; do :; done"); err != nil {
			return err
		}
		raw, e := docker("inspect", "--format", "{{.State.Pid}}", name)
		if e != nil {
			return e
		}
		pid, e := strconv.Atoi(raw)
		if e != nil {
			return e
		}
		if err = manager.Verify(key, pid); err != nil {
			return err
		}
		membership, e := os.ReadFile(fmt.Sprintf("/proc/%d/cgroup", pid))
		if e != nil {
			return e
		}
		pids = append(pids, pid)
		members = append(members, strings.TrimSpace(string(membership)))
	}
	dir := filepath.Join("/sys/fs/cgroup", slice, parent)
	files := map[string]string{}
	for _, n := range []string{"memory.max", "memory.swap.max", "cpu.max", "pids.max", "memory.current", "pids.current", "cpu.stat"} {
		b, e := os.ReadFile(filepath.Join(dir, n))
		if e != nil {
			return e
		}
		files[n] = strings.TrimSpace(string(b))
	}
	if files["memory.max"] != "268435456" || files["memory.swap.max"] != "0" || files["cpu.max"] != "50000 100000" || files["pids.max"] != "256" {
		return fmt.Errorf("kernel resource ceiling mismatch: %v", files)
	}
	time.Sleep(1200 * time.Millisecond)
	after, e := os.ReadFile(filepath.Join(dir, "cpu.stat"))
	if e != nil {
		return e
	}
	stats := map[string]int64{}
	for _, line := range strings.Split(string(after), "\n") {
		parts := strings.Fields(line)
		if len(parts) == 2 {
			v, e := strconv.ParseInt(parts[1], 10, 64)
			if e == nil {
				stats[parts[0]] = v
			}
		}
	}
	if stats["nr_throttled"] <= 0 || stats["throttled_usec"] <= 0 {
		return fmt.Errorf("busy children did not demonstrate CPU throttling: %v", stats)
	}
	if err = cleanupNativeContainers(*socket, names, *id, parent); err != nil {
		return err
	}
	if err = manager.Remove(key); err != nil {
		return err
	}
	if err = manager.RequireEmpty(); err != nil {
		return err
	}
	cleaned = true
	result := map[string]any{"id": *id, "backend": "native-systemd-dbus", "rootSlice": slice, "claimParent": parent, "containerPids": pids, "memberships": members, "kernel": files, "cpuStatAfter": strings.TrimSpace(string(after)), "runtime": "runsc --systemd-cgroup", "cleanup": "both containers and claim slice removed", "scope": "two tiny busy-loop containers; aggregate configured/readback, PID containment; no guest-process accounting promise"}
	out, _ := json.MarshalIndent(result, "", "  ")
	fmt.Println(string(out))
	return nil
}

// A name collision is never permission to destroy a container. Both trust
// attributes are checked immediately before removal, against the private daemon.
func ownsNativeContainer(label, actualParent, uuid, expectedParent string) bool {
	return uuid != "" && expectedParent != "" && label == uuid && actualParent == expectedParent
}
func cleanupNativeContainers(socket string, names []string, uuid, parent string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var failures []error
	for _, name := range names {
		args := []string{"--host", socket, "container", "inspect", "--format", `{"id":{{json .Id}},"labels":{{json .Config.Labels}},"parent":{{json .HostConfig.CgroupParent}}}`, name}
		body, e := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
		if e != nil {
			if strings.Contains(string(body), "No such container") || strings.Contains(string(body), "No such object") {
				continue
			}
			failures = append(failures, fmt.Errorf("inspect native cleanup %s: %w", name, e))
			continue
		}
		var owned struct {
			ID     string            `json:"id"`
			Labels map[string]string `json:"labels"`
			Parent string            `json:"parent"`
		}
		if json.Unmarshal(body, &owned) != nil || !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(owned.ID) || !ownsNativeContainer(owned.Labels["kodus.integrated"], owned.Parent, uuid, parent) {
			failures = append(failures, fmt.Errorf("native cleanup ownership mismatch for %s", name))
			continue
		}
		if out, e := exec.CommandContext(ctx, "docker", "--host", socket, "rm", "-f", "-v", owned.ID).CombinedOutput(); e != nil {
			failures = append(failures, fmt.Errorf("remove native fixture %s: %w: %s", name, e, out))
		}
	}
	return errors.Join(failures...)
}
