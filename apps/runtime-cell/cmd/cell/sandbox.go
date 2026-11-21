package main

import "flag"

// Code sandboxes (docs/runtime/sandbox.md): the tool image docker-gvisor
// boots them from, how many blank ones the cell keeps ready, and the size a
// sandbox that asks none runs at.
type sandboxSettings struct {
	Image    string
	Pool     int
	MemoryMB int
	CPUs     int
	// GuestTrace: the step's traceparent goes to the guest agent (agent.Config.GuestTraceContext).
	GuestTrace bool
}

// The default sandbox size: what a blank sandbox commits, well under a Run's
// default size (-gvisor-mem-limit), so a sandbox never waits for a Run's room.
const (
	defaultSandboxMemoryMB = 2048
	defaultSandboxCPUs     = 2
)

func (s *sandboxSettings) register(fs *flag.FlagSet) {
	fs.StringVar(&s.Image, "gvisor-sandbox-image", "", "docker-gvisor: the code sandbox's tool image, by digest, with the guest agent at /usr/local/bin/kody-guest; empty: the cell runs no sandboxes")
	fs.IntVar(&s.Pool, "sandbox-pool", 0, "how many blank code sandboxes the cell keeps ready (each taken by one claim and destroyed on its release); 0: none")
	fs.IntVar(&s.MemoryMB, "sandbox-memory-mb", defaultSandboxMemoryMB, "docker-gvisor: the memory (MB) of a code sandbox that asks no size, and of every blank one; counted at it in the memory admission. A caller may ask more, up to the cell's maximum (-gvisor-mem-max)")
	fs.BoolVar(&s.GuestTrace, "sandbox-guest-trace", false, "send each sandbox op's traceparent to the guest agent; only with a sandbox image whose kody-guest decodes it (built from the same commit as this cell or later)")
	fs.IntVar(&s.CPUs, "sandbox-cpus", defaultSandboxCPUs, "docker-gvisor: the CPUs of a code sandbox that asks no size, and of every blank one; never above the cell's maximum (-gvisor-cpus-max)")
}
