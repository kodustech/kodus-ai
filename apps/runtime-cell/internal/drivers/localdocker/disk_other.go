//go:build !unix

package localdocker

import "github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"

func diskOf(string) (driver.DiskDiagnostics, bool) { return driver.DiskDiagnostics{}, false }
