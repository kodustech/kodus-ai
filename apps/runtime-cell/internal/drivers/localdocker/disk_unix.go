//go:build unix

package localdocker

import (
	"syscall"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

func diskOf(path string) (driver.DiskDiagnostics, bool) {
	var st syscall.Statfs_t
	if path == "" || syscall.Statfs(path, &st) != nil {
		return driver.DiskDiagnostics{}, false
	}
	bs := int64(st.Bsize)
	return driver.DiskDiagnostics{Path: path, TotalBytes: int64(st.Blocks) * bs, FreeBytes: int64(st.Bavail) * bs}, true
}
