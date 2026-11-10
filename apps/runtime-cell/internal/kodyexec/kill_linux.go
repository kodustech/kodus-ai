//go:build linux

package kodyexec

import (
	"os"
	"strconv"
	"strings"
	"syscall"
)

const prSetChildSubreaper = 36

func setSubreaper() error {
	_, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, prSetChildSubreaper, 1, 0)
	if errno != 0 {
		return errno
	}
	return nil
}

// killTree kills the command's process group, then every live descendant
// of the command (or, as a subreaper, of this process), in rounds until none
// is left: a process that called setsid is no longer in the group but is
// still a descendant.
func killTree(pid int) {
	_ = syscall.Kill(-pid, syscall.SIGKILL)
	root := pid
	if subreaper.Load() {
		root = os.Getpid()
	}
	for round := 0; round < 5; round++ {
		kids := descendants(root)
		if len(kids) == 0 {
			return
		}
		for _, k := range kids {
			_ = syscall.Kill(k, syscall.SIGKILL)
		}
	}
}

// descendants reads the process tree from /proc: every pid under root that
// is not a zombie.
func descendants(root int) []int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	parent := map[int]int{}
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		b, err := os.ReadFile("/proc/" + e.Name() + "/stat")
		if err != nil {
			continue
		}
		// pid (comm) state ppid ...; comm may hold spaces and parentheses.
		rest := string(b)
		if i := strings.LastIndexByte(rest, ')'); i >= 0 {
			rest = rest[i+1:]
		}
		f := strings.Fields(rest)
		if len(f) < 2 || f[0] == "Z" {
			continue
		}
		if ppid, err := strconv.Atoi(f[1]); err == nil {
			parent[pid] = ppid
		}
	}
	var out []int
	for pid := range parent {
		if pid == root {
			continue
		}
		for p, hops := parent[pid], 0; hops < 64; p, hops = parent[p], hops+1 {
			if p == root {
				out = append(out, pid)
				break
			}
			if p <= 1 {
				break
			}
		}
	}
	return out
}
