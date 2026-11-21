//go:build !linux

package guestinit

// Run is Linux only: a microVM's guest runs Linux.
func Run() error { return ErrNotLinux }
