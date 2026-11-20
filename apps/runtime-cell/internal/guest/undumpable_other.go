//go:build !linux

package guest

// Undumpable is Linux's PR_SET_DUMPABLE; a sandbox's guest agent runs on
// Linux only, so elsewhere (a developer's machine running the tests) it does
// nothing.
func Undumpable() error { return nil }

// Dumpable reports false off Linux, where the flag does not exist.
func Dumpable() (bool, error) { return false, nil }
