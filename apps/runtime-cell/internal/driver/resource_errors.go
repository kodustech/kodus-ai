package driver

import "errors"

// ErrResourceEnforcement means the cell could not establish or verify the
// host's requested resource boundary. It is an infrastructure failure,
// never evidence that the repository's build or behavior is defective.
var ErrResourceEnforcement = errors.New("driver: resource_enforcement_unavailable")

// ErrResourceCleanupPending means an operation returned without proving its
// resource-consuming helper is gone. Its reservation must remain quarantined
// until physical cleanup is established; an RPC/CLI error alone is not release.
var ErrResourceCleanupPending = errors.New("driver: resource_cleanup_pending")
