//go:build linux && dockersmoke

package claimlimits

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestKernelCeilings uses only a predelegated, exclusive test root. It never
// creates/delegates ancestors or changes the daemon. All stress processes run
// in private child cgroups before executing the test helper. This proves kernel
// controls, not Docker/runsc attachment; the latter has a separate integration gate.
func TestKernelCeilings(t *testing.T) {
	root := os.Getenv("KODY_CGROUP_TEST_ROOT")
	if root == "" {
		t.Skip("requires an exclusive delegated KODY_CGROUP_TEST_ROOT on local Linux")
	}
	manager, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	if second, err := New(root); err == nil {
		second.Close()
		t.Fatal("second manager acquired live delegated root")
	}
	t.Log("exclusive delegated-root lock refused a second manager")
	for _, mode := range []string{"memory", "cpu", "pids"} {
		t.Run(mode, func(t *testing.T) {
			keyBytes := make([]byte, 32)
			if _, err := rand.Read(keyBytes); err != nil {
				t.Fatal(err)
			}
			key := hex.EncodeToString(keyBytes)
			limits := Limits{MemoryBytes: 128 << 20, CPUQuota: 20000, CPUPeriod: 100000, Pids: 64}
			if mode == "memory" {
				limits.MemoryBytes = 64 << 20
			}
			if mode == "pids" {
				limits.Pids = 24
			}
			parent, err := manager.Ensure(key, limits)
			if err != nil {
				t.Fatal(err)
			}
			group, err := manager.root.Open(key)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				group.Close()
				if err := manager.Remove(key); err != nil {
					t.Error(err)
				}
			})
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			var commands []*exec.Cmd
			var starts []io.WriteCloser
			var children []string
			defer func() {
				for _, start := range starts {
					_ = start.Close()
				}
				for _, cmd := range commands {
					if cmd.ProcessState == nil {
						_ = cmd.Process.Kill()
						_ = cmd.Wait()
					}
				}
				for _, name := range children {
					if err := group.Remove(name); err != nil {
						t.Error(err)
					}
				}
			}()
			count := 1
			if mode == "memory" || mode == "cpu" {
				count = 2
			}
			for i := 0; i < count; i++ {
				name := "member-" + strconv.Itoa(i)
				if err := group.Mkdir(name); err != nil {
					t.Fatal(err)
				}
				children = append(children, name)
				child, err := group.Open(name)
				if err != nil {
					t.Fatal(err)
				}
				fd := int(child.(*localDirectory).file.Fd())
				cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestKernelResourceHelper$", "-test.count=1")
				cmd.Env = append(os.Environ(), "KODY_CGROUP_HELPER="+mode, "GOMAXPROCS=2")
				cmd.SysProcAttr = &syscall.SysProcAttr{UseCgroupFD: true, CgroupFD: fd}
				start, e := cmd.StdinPipe()
				if e != nil {
					child.Close()
					t.Fatal(e)
				}
				starts = append(starts, start)
				err = cmd.Start()
				child.Close()
				if err != nil {
					t.Fatal(err)
				}
				commands = append(commands, cmd)
				if err := manager.Verify(key, cmd.Process.Pid); err != nil {
					t.Fatal(err)
				}
			}
			for _, start := range starts {
				if _, err := start.Write([]byte{1}); err != nil {
					t.Fatal(err)
				}
				_ = start.Close()
			}
			for _, cmd := range commands {
				_ = cmd.Wait()
			}
			file, field := "memory.events", "oom_kill"
			if mode == "cpu" {
				file, field = "cpu.stat", "nr_throttled"
			}
			if mode == "pids" {
				file, field = "pids.events", "max"
			}
			events, err := group.Read(file)
			if err != nil {
				t.Fatal(err)
			}
			if counter(events, field) < 1 {
				t.Fatalf("%s did not engage: %s", file, events)
			}
			t.Logf("parent=%s mode=%s %s=%d", parent, mode, field, counter(events, field))
		})
	}
	if err := manager.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := New(root)
	if err != nil {
		t.Fatalf("root lock was not released after manager close: %v", err)
	}
	if err := reopened.Close(); err != nil {
		t.Fatal(err)
	}
	t.Log("delegated-root lock released after manager close")
}

// TestKernelLowerReclaimsFileCacheWithoutKilling is what SettleReady relies
// on: a group whose memory.current is mostly file cache (a claim after its
// builds) takes a memory.max below memory.current but above its working set
// by reclaiming the cache, with no process killed.
func TestKernelLowerReclaimsFileCacheWithoutKilling(t *testing.T) {
	root := os.Getenv("KODY_CGROUP_TEST_ROOT")
	if root == "" {
		t.Skip("requires an exclusive delegated KODY_CGROUP_TEST_ROOT on local Linux")
	}
	manager, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	// A cleanup, not a defer: cleanups run after the function returns, last
	// registered first, so the group is removed before the manager closes.
	t.Cleanup(func() { _ = manager.Close() })
	keyBytes := make([]byte, 32)
	if _, err = rand.Read(keyBytes); err != nil {
		t.Fatal(err)
	}
	key := hex.EncodeToString(keyBytes)
	if _, err = manager.Ensure(key, Limits{MemoryBytes: 512 << 20, CPUQuota: 100000, CPUPeriod: 100000, Pids: 64}); err != nil {
		t.Fatal(err)
	}
	group, err := manager.root.Open(key)
	if err != nil {
		t.Fatal(err)
	}
	if err = group.Mkdir("member"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = group.Remove("member")
		group.Close()
		if err := manager.Remove(key); err != nil {
			t.Error(err)
		}
	})
	child, err := group.Open("member")
	if err != nil {
		t.Fatal(err)
	}
	// On disk, not tmpfs: tmpfs pages are shmem, which nothing reclaims.
	dir, err := os.MkdirTemp(".", "cache-smoke-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestKernelResourceHelper$", "-test.count=1")
	cmd.Env = append(os.Environ(), "KODY_CGROUP_HELPER=cache", "KODY_CGROUP_CACHE_DIR="+dir)
	cmd.SysProcAttr = &syscall.SysProcAttr{UseCgroupFD: true, CgroupFD: int(child.(*localDirectory).file.Fd())}
	start, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	err = cmd.Start()
	child.Close()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = start.Write([]byte{1}); err != nil {
		t.Fatal(err)
	}
	ready := make([]byte, 6)
	if _, err = io.ReadFull(out, ready); err != nil || string(ready) != "cached" {
		t.Fatalf("helper: %q %v", ready, err)
	}
	u, err := manager.Usage(key)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("before: current=%d file=%d shmem=%d working=%d", u.CurrentBytes, u.FileBytes, u.ShmemBytes, u.WorkingSetBytes())
	if u.CurrentBytes < 200<<20 || u.WorkingSetBytes() > 96<<20 {
		t.Fatalf("the helper did not fill the group with cache: %+v", u)
	}
	lowered := u.WorkingSetBytes() + 64<<20
	if err = manager.Lower(key, lowered); err != nil {
		t.Fatal(err)
	}
	after, err := manager.Usage(key)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("after: current=%d max=%d oom_kill=%d", after.CurrentBytes, lowered, after.OOMKills)
	if after.CurrentBytes > lowered || after.OOMKills != 0 {
		t.Fatalf("lowered to %d: %+v", lowered, after)
	}
	_ = start.Close()
	if err = cmd.Wait(); err != nil {
		t.Fatalf("the helper did not survive the lower: %v", err)
	}
}

func counter(raw, name string) int64 {
	for _, row := range strings.Split(raw, "\n") {
		fields := strings.Fields(row)
		if len(fields) == 2 && fields[0] == name {
			v, _ := strconv.ParseInt(fields[1], 10, 64)
			return v
		}
	}
	return 0
}

func TestKernelResourceHelper(t *testing.T) {
	mode := os.Getenv("KODY_CGROUP_HELPER")
	if mode == "" {
		return
	}
	var start [1]byte
	if _, err := io.ReadFull(os.Stdin, start[:]); err != nil {
		t.Fatal(err)
	}
	switch mode {
	case "memory":
		buf := make([]byte, 40<<20)
		for i := 0; i < len(buf); i += 4096 {
			buf[i] = 1
		}
		time.Sleep(2 * time.Second)
		runtime.KeepAlive(buf)
	case "cpu":
		end := time.Now().Add(2 * time.Second)
		var n uint64
		for time.Now().Before(end) {
			n++
		}
		runtime.KeepAlive(n)
	case "pids":
		for i := 0; i < 64; i++ {
			go func() { runtime.LockOSThread(); select {} }()
		}
		time.Sleep(2 * time.Second)
	case "cache":
		// 256 MB of file cache and 16 MB of its own, then wait for the lower.
		f, err := os.Create(os.Getenv("KODY_CGROUP_CACHE_DIR") + "/fill")
		if err != nil {
			t.Fatal(err)
		}
		chunk := make([]byte, 1<<20)
		for i := 0; i < 256; i++ {
			if _, err = f.Write(chunk); err != nil {
				t.Fatal(err)
			}
		}
		if err = f.Sync(); err != nil {
			t.Fatal(err)
		}
		f.Close()
		own := make([]byte, 16<<20)
		for i := 0; i < len(own); i += 4096 {
			own[i] = 1
		}
		if _, err = os.Stdout.Write([]byte("cached")); err != nil {
			t.Fatal(err)
		}
		_, _ = io.ReadAll(os.Stdin)
		runtime.KeepAlive(own)
	default:
		t.Fatal(fmt.Errorf("unexpected owned helper mode"))
	}
}
