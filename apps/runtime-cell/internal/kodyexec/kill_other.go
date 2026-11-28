//go:build !linux

package kodyexec

import (
	"errors"
	"syscall"
)

func setSubreaper() error { return errors.New("kodyexec: no child subreaper on this OS") }

// killTree kills the command's process group. Without /proc a process that
// left the group stays alive; Run still returns within KillGrace.
func killTree(pid int) { _ = syscall.Kill(-pid, syscall.SIGKILL) }
