package buildstate

// MountedOverlays lists the overlays the kernel has mounted at or under a
// directory; none where the cell mounts none (not Linux).
func MountedOverlays(under string) ([]OverlayMount, error) {
	m := DefaultMounter()
	if m == nil {
		return nil, nil
	}
	return m.Mounted(under)
}
