package tarball

import "runtime"

func onLinux() bool { return runtime.GOOS == "linux" }
