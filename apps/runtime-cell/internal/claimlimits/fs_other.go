//go:build !linux

package claimlimits

import "fmt"

// New refuses non-Linux hosts. A remote Linux Docker daemon does not supply
// the local cgroup hierarchy required to enforce and verify these limits.
func New(root string) (*FS, error) {
	return nil, fmt.Errorf("%w: local Linux cgroup v2 required", ErrUnavailable)
}
func readProcessCgroup(pid int) (string, error) {
	return "", fmt.Errorf("%w: local Linux required", ErrUnavailable)
}
