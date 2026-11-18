package dockergvisor

// hooksForTest is the driver's test seams, made on first use.
func (d *Driver) hooksForTest() *testHooks {
	if d.hooks == nil {
		d.hooks = &testHooks{}
	}
	return d.hooks
}
