package guestinit

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"regexp"
	"strings"
)

// ControlPort is the vsock port PID 1 serves the cell's snapshot steps on
// (docs/runtime/isolation-p3-snapshots.md). It is below 1024, a port the
// guest's kernel lets only a privileged process bind (vsock's reserved
// ports): a sandbox's commands, user 1000 with no capability, can never
// serve it in init's place.
const ControlPort = 1023

// HostCID is the vsock address of the host: init answers no one else on the
// control port.
const HostCID = 2

// maxControl bounds one control message, either way.
const maxControl = 4096

// ControlOp is one step the cell asks of init.
type ControlOp string

const (
	// OpPrepare: the machine is about to be snapshotted. Init refuses when
	// it holds what no snapshot for that purpose may (a sandbox template
	// with any process of its workload running), removes the seed files an
	// init system keeps, and freezes every process of the workload until a
	// rebirth or a thaw.
	OpPrepare ControlOp = "prepare"
	// OpThaw: the snapshot did not happen; the workload runs again.
	OpThaw ControlOp = "thaw"
	// OpRebirth: the machine was restored from a snapshot. Init reseeds the
	// kernel's random generator with the host's bytes, sets the clock to
	// the host's, takes the machine's new names and address, then thaws
	// the workload: nothing of the workload runs before all of it is done.
	OpRebirth ControlOp = "rebirth"
)

// ControlRequest is one message of the cell to init.
type ControlRequest struct {
	Op ControlOp `json:"op"`
	// Purpose is OpPrepare's: "template" (many machines start from it),
	// "session" (one machine comes back from it) or "round" (its claim's
	// same machine comes back from it on every reset).
	Purpose string `json:"purpose,omitempty"`
	// Rebirth is OpRebirth's.
	Rebirth *Rebirth `json:"rebirth,omitempty"`
}

// SeedBytes is how much of the host's randomness a rebirth carries.
const SeedBytes = 64

// Rebirth is what makes a restored machine its own.
type Rebirth struct {
	// Seed is SeedBytes from the host's random generator, mixed into the
	// guest kernel's and credited, then the kernel reseeds from it.
	Seed []byte `json:"seed"`
	// UnixNano is the host's wall clock when it sent this.
	UnixNano int64 `json:"unixNano"`
	// Hostname, BootID (a UUID) and MachineID (32 hex digits) are the new
	// machine's.
	Hostname  string `json:"hostname"`
	BootID    string `json:"bootId"`
	MachineID string `json:"machineId"`
	// Net is eth0 on the new machine's tap; nil: the machine has none.
	Net *NetConfig `json:"net,omitempty"`
	// DNS is the claim's resolver; invalid: none.
	DNS netip.Addr `json:"dns,omitzero"`
}

// NetConfig is one interface's address.
type NetConfig struct {
	MAC     string     `json:"mac"`
	IP      netip.Addr `json:"ip"`
	Prefix  int        `json:"prefix"`
	Gateway netip.Addr `json:"gateway"`
}

var (
	uuidRE      = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	machineIDRE = regexp.MustCompile(`^[0-9a-f]{32}$`)
	macRE       = regexp.MustCompile(`^[0-9a-f]{2}(:[0-9a-f]{2}){5}$`)
)

// Validate refuses a rebirth init could not apply as given.
func (r Rebirth) Validate() error {
	switch {
	case len(r.Seed) != SeedBytes:
		return fmt.Errorf("guestinit: a %d-byte seed", len(r.Seed))
	case r.UnixNano <= 0:
		return errors.New("guestinit: no clock")
	case !hostnameRE.MatchString(r.Hostname):
		return fmt.Errorf("guestinit: hostname %q", r.Hostname)
	case !uuidRE.MatchString(r.BootID):
		return fmt.Errorf("guestinit: boot id %q", r.BootID)
	case !machineIDRE.MatchString(r.MachineID):
		return fmt.Errorf("guestinit: machine id %q", r.MachineID)
	case r.DNS.IsValid() && !r.DNS.Is4():
		return fmt.Errorf("guestinit: resolver %s", r.DNS)
	}
	if n := r.Net; n != nil {
		mac, _ := hexMAC(n.MAC)
		switch {
		case !macRE.MatchString(n.MAC) || mac[0]&1 == 1:
			return fmt.Errorf("guestinit: MAC %q", n.MAC)
		case !n.IP.Is4() || !n.Gateway.Is4() || n.Prefix < 8 || n.Prefix > 30:
			return fmt.Errorf("guestinit: address %s/%d via %s", n.IP, n.Prefix, n.Gateway)
		case !netip.PrefixFrom(n.IP, n.Prefix).Masked().Contains(n.Gateway) || n.IP == n.Gateway:
			return fmt.Errorf("guestinit: gateway %s is not on %s/%d", n.Gateway, n.IP, n.Prefix)
		}
	}
	return nil
}

// hexMAC is a MAC's six bytes.
func hexMAC(s string) ([6]byte, error) {
	var b [6]byte
	parts := strings.Split(s, ":")
	if len(parts) != 6 {
		return b, fmt.Errorf("guestinit: MAC %q", s)
	}
	for i, p := range parts {
		var v byte
		if _, err := fmt.Sscanf(p, "%02x", &v); err != nil || len(p) != 2 {
			return b, fmt.Errorf("guestinit: MAC %q", s)
		}
		b[i] = v
	}
	return b, nil
}

// ControlReply is init's answer.
type ControlReply struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
	// BootID is /proc/sys/kernel/random/boot_id as the machine's processes
	// read it after a rebirth.
	BootID string `json:"bootId,omitempty"`
	// UnixNano is the guest's wall clock when it answered.
	UnixNano int64 `json:"unixNano,omitempty"`
}

// WriteControl writes one control message as a line.
func WriteControl(w io.Writer, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(b) >= maxControl {
		return fmt.Errorf("guestinit: a %d-byte control message", len(b))
	}
	_, err = w.Write(append(b, '\n'))
	return err
}

// ReadControl reads one control message, refusing one longer than the
// bound or with a field this side does not know.
func ReadControl(r io.Reader, v any) error {
	line, err := bufio.NewReaderSize(io.LimitReader(r, maxControl), maxControl).ReadSlice('\n')
	if err != nil {
		return fmt.Errorf("guestinit: control message: %w", err)
	}
	dec := json.NewDecoder(strings.NewReader(string(line)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("guestinit: control message: %w", err)
	}
	return nil
}
