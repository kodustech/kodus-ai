//go:build unix

package exercised

import "syscall"

const noFollow = syscall.O_NOFOLLOW
