package dockergvisor

// HelperImage is the data helper image the driver runs for a configured
// -gvisor-helper-image: the pinned busybox when it is empty, an error when
// it is not pinned by digest (as New refuses it). cmd/cell preflight
// -network checks that it resolves.
func HelperImage(configured string) (string, error) { return helperImage(configured) }
