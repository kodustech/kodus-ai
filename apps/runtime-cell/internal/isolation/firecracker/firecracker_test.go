package firecracker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guestinit"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kit"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/placement/hostnet"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

func argValues(args []string, flag string) []string {
	var out []string
	for i := 0; i < len(args)-1; i++ {
		if args[i] == "--" {
			break
		}
		if args[i] == flag {
			out = append(out, args[i+1])
		}
	}
	return out
}

// The jailer runs firecracker as the machine's own user, chrooted under the
// cell's jail base, alone in a new PID namespace, daemonized, in a cgroup of
// the cell's parent bounded to the machine's memory and CPUs, with a bound
// on what it may write; the VMM takes its API socket and config in the jail.
func TestTheJailerConfinesTheVMMToTheMachinesUserJailAndSize(t *testing.T) {
	args := Jail{
		ID: "kfc-0123456789abcdef0123", Exec: "/kit/bin/firecracker", UID: 900007, GID: 900007,
		ChrootBase: "/var/lib/cell/microvm/jail", CgroupParent: "kodus-microvm", MemoryMB: 1024, CPUs: 2,
	}.Args()
	for flag, want := range map[string]string{
		"--id": "kfc-0123456789abcdef0123", "--exec-file": "/kit/bin/firecracker", "--uid": "900007", "--gid": "900007",
		"--chroot-base-dir": "/var/lib/cell/microvm/jail", "--cgroup-version": "2", "--parent-cgroup": "kodus-microvm",
	} {
		if got := argValues(args, flag); len(got) != 1 || got[0] != want {
			t.Errorf("%s = %v, want %s", flag, got, want)
		}
	}
	cg := argValues(args, "--cgroup")
	// memory.max: the guest's memory, the VMM's own and the host page cache
	// its disk writes take, so a guest that writes its disk fast is never
	// OOM-killed for the cache (S-09).
	for _, want := range []string{"memory.max=" + itoa((1024+vmmOverheadMB+vmmCacheMinMB)<<20), "cpu.max=200000 100000"} {
		if !slices.Contains(cg, want) {
			t.Errorf("cgroup %v lacks %s", cg, want)
		}
	}
	if rl := argValues(args, "--resource-limit"); !slices.Contains(rl, "fsize="+itoa(maxLogBytes)) {
		t.Errorf("no bound on the files it writes: %v", rl)
	}
	sep := slices.Index(args, "--")
	if sep < 0 || !slices.Contains(args[:sep], "--new-pid-ns") || !slices.Contains(args[:sep], "--daemonize") {
		t.Fatalf("not daemonized in its own PID namespace: %v", args)
	}
	if vmm := strings.Join(args[sep+1:], " "); vmm != "--api-sock /api.sock --config-file /config.json" {
		t.Fatalf("the VMM's arguments: %q", vmm)
	}
}

func itoa(n int) string { return strconv.Itoa(n) }

// A sandbox boots its root read-only with the guest agent as init, no
// serial console, its address and gateway set on eth0, and the guest's boot
// values reading back as the guest agent parses them; an environment's root
// and data disk are writable.
func TestAMachinesConfigBootsTheGuestAgentWithItsNetworkAndBounds(t *testing.T) {
	boot := guestinit.Boot{Hostname: "kfc-0123", DNS: netip.MustParseAddr("10.212.255.1"), Port: 1024, WorkspaceMB: 256, TmpMB: 512}
	n := &Net{Tap: "kft0011223344", MAC: "06:00:0a:d5:04:80", IP: netip.MustParseAddr("10.213.4.128"), Gateway: netip.MustParseAddr("10.213.4.1"), Prefix: 24}
	raw, err := VM{VCPUs: 1, MemoryMB: 512, ReadOnlyRoot: true, Net: n, Boot: boot}.Config()
	if err != nil {
		t.Fatal(err)
	}
	var cfg struct {
		Boot struct {
			Kernel string `json:"kernel_image_path"`
			Args   string `json:"boot_args"`
		} `json:"boot-source"`
		Drives  []drive `json:"drives"`
		Machine struct {
			VCPUs int `json:"vcpu_count"`
			Mem   int `json:"mem_size_mib"`
		} `json:"machine-config"`
		Net []struct {
			MAC string `json:"guest_mac"`
			Tap string `json:"host_dev_name"`
		} `json:"network-interfaces"`
		Vsock struct {
			CID int    `json:"guest_cid"`
			UDS string `json:"uds_path"`
		} `json:"vsock"`
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	args := " " + cfg.Boot.Args + " "
	// The i8042 set skips the keyboard controller's probe: 713 -> 263 ms to
	// init on the Firecracker spike's host.
	for _, want := range []string{
		" init=/usr/local/bin/kody-guest ", " ro ", " 8250.nr_uarts=0 ", " ip=10.213.4.128::10.213.4.1:255.255.255.0:kfc-0123:eth0:off ",
		" i8042.noaux ", " i8042.nomux ", " i8042.nopnp ", " i8042.dumbkbd ",
	} {
		if !strings.Contains(args, want) {
			t.Errorf("boot args lack %q: %s", want, cfg.Boot.Args)
		}
	}
	if strings.Contains(args, "console=") {
		t.Errorf("a serial console: %s", cfg.Boot.Args)
	}
	if got, err := guestinit.ParseCmdline(cfg.Boot.Args); err != nil || got != boot {
		t.Fatalf("the guest reads %+v %v, the cell wrote %+v", got, err, boot)
	}
	if len(cfg.Drives) != 1 || !cfg.Drives[0].Root || !cfg.Drives[0].ReadOnly || cfg.Machine.VCPUs != 1 || cfg.Machine.Mem != 512 {
		t.Fatalf("drives %+v machine %+v", cfg.Drives, cfg.Machine)
	}
	if len(cfg.Net) != 1 || cfg.Net[0].MAC != n.MAC || cfg.Net[0].Tap != n.Tap || cfg.Vsock.UDS != "/v.sock" || cfg.Vsock.CID != 3 {
		t.Fatalf("net %+v vsock %+v", cfg.Net, cfg.Vsock)
	}
	raw, err = VM{VCPUs: 4, MemoryMB: 8192, DataDisk: true, Boot: guestinit.Boot{Hostname: "kfc-1", Port: 1024, TmpMB: 512}}.Config()
	if err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal(raw, &cfg)
	if len(cfg.Drives) != 2 || cfg.Drives[0].ReadOnly || cfg.Drives[1].ReadOnly || cfg.Drives[1].Root || !strings.Contains(cfg.Boot.Args, " rw ") {
		t.Fatalf("environment drives %+v args %s", cfg.Drives, cfg.Boot.Args)
	}
}

// A host that lacks prerequisites is refused, every missing one named, so
// the operator fixes them in one go.
func TestAHostWithoutThePrerequisitesIsRefusedNamingEachOne(t *testing.T) {
	checks := &Checks{
		EUID:     func() int { return 1000 },
		LookPath: func(b string) (string, error) { return "", errors.New("not found") },
		Stat:     func(string) (os.FileInfo, error) { return nil, fs.ErrNotExist },
		ReadFile: func(string) ([]byte, error) { return []byte("cpu io"), nil },
		Reflink:  func(string, string) error { return errors.New("operation not supported") },
	}
	state, err := os.MkdirTemp("/tmp", "fc")
	if err != nil {
		t.Skip("no /tmp:", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(state) })
	_, err = New(Config{StateDir: state, Checks: checks, Host: isolation.Host{Arch: "x86_64"}})
	var u *isolation.UnavailableError
	if !errors.As(err, &u) || u.Backend != isolation.Firecracker {
		t.Fatalf("err %v", err)
	}
	for _, want := range []string{"/dev/kvm", "no microVM kit", "needs root", "memory, cpu and pids", "nft", "/dev/net/tun", "XFS with reflink=1 or btrfs", "no host-network placement"} {
		if !strings.Contains(u.Reason, want) {
			t.Errorf("the refusal does not name %q: %s", want, u.Reason)
		}
	}
}

// ---- a backend on a fake host: the launcher plays firecracker ----

type fakeNet struct {
	mu   sync.Mutex
	taps map[string]hostnet.Attachment
	n    int
}

func (f *fakeNet) AttachTapAt(_ context.Context, network, machine string, uid int, want netip.Addr) (hostnet.Attachment, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.n++
	a := hostnet.Attachment{
		Tap: "kft" + machine, MAC: "06:00:0a:00:00:" + itoa(f.n), IP: netip.MustParseAddr("10.213.0." + itoa(127+f.n)),
		Gateway: netip.MustParseAddr("10.213.0.1"), Prefix: 24, DNS: netip.MustParseAddr("10.212.255.1"),
	}
	if want.IsValid() {
		a.IP, a.MAC = want, "06:00:0a:00:01:"+itoa(int(want.As4()[3]))
	}
	a.Netns = "/run/netns/kfn-" + machine
	f.taps[network+"/"+machine] = a
	return a, nil
}

func (f *fakeNet) DetachTap(_ context.Context, network, machine string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.taps, network+"/"+machine)
	return nil
}

// fakeVMM stands in for the jailed firecracker: the API socket answers, and
// the vsock socket serves the real guest agent on a directory of its own.
type fakeVMM struct {
	t      *testing.T
	mu     sync.Mutex
	state  map[string]string
	args   map[string][]string
	listen []net.Listener
	fail   bool
	// calls are the API calls and control requests, per machine, in order.
	calls map[string][]string
	// loads are the snapshot loads' bodies, controls the control requests.
	loads    map[string]map[string]any
	controls map[string][]guestinit.ControlRequest
	// refuse makes init refuse that control op; failCreate the snapshot.
	refuse     guestinit.ControlOp
	failCreate bool
	// createTakes delays the snapshot's create, as a full page cache does.
	createTakes time.Duration
	// logs is what the VMM writes to its jail's log as it starts.
	logs string
	// onCreate runs as a snapshot's create starts.
	onCreate func(id string)
	// limits are the PATCHed token buckets, per machine.
	limits map[string][]map[string]any
}

func (v *fakeVMM) record(id, call string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.calls == nil {
		v.calls = map[string][]string{}
	}
	v.calls[id] = append(v.calls[id], call)
}

func (v *fakeVMM) callsOf(id string) []string {
	v.mu.Lock()
	defer v.mu.Unlock()
	return append([]string(nil), v.calls[id]...)
}

// memMB is the guest's memory a jailer's arguments give its cgroup.
func memMB(args []string) int {
	for _, c := range argValues(args, "--cgroup") {
		if v, ok := strings.CutPrefix(c, "memory.max="); ok {
			n, _ := strconv.ParseInt(v, 10, 64)
			m := int(n>>20) - vmmOverheadMB
			if m-vmmCacheMinMB <= 2*vmmCacheMinMB {
				return m - vmmCacheMinMB
			}
			return m * 2 / 3
		}
	}
	return 0
}

func (v *fakeVMM) Launch(ctx context.Context, _ string, args []string) error {
	// The machine outlives the call that started it, as a daemonized VMM does.
	life := context.WithoutCancel(ctx)
	id := argValues(args, "--id")[0]
	root := filepath.Join(argValues(args, "--chroot-base-dir")[0], execName, id, "root")
	if v.logs != "" {
		f, err := os.OpenFile(filepath.Join(root, strings.TrimPrefix(jailLog, "/")), os.O_APPEND|os.O_WRONLY, 0)
		if err != nil {
			return err
		}
		_, _ = f.WriteString(v.logs)
		_ = f.Close()
	}
	if v.fail {
		return errors.New("jailer: exit status 1")
	}
	v.mu.Lock()
	v.state[id], v.args[id] = "Running", args
	if !slices.Contains(args, "--config-file") {
		v.state[id] = "Not started" // a restore: the machine comes with the load
	}
	v.mu.Unlock()
	apiL, err := net.Listen("unix", filepath.Join(root, "api.sock"))
	if err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /", func(w http.ResponseWriter, _ *http.Request) {
		v.mu.Lock()
		defer v.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]string{"state": v.state[id]})
	})
	mux.HandleFunc("PATCH /vm", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ State string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		v.mu.Lock()
		v.state[id] = map[string]string{"Paused": "Paused", "Resumed": "Running"}[body.State]
		v.mu.Unlock()
		v.record(id, "vm "+body.State)
		w.WriteHeader(http.StatusNoContent)
	})
	limited := func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		v.mu.Lock()
		if v.limits == nil {
			v.limits = map[string][]map[string]any{}
		}
		v.limits[id] = append(v.limits[id], body)
		v.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	}
	mux.HandleFunc("PATCH /drives/{drive}", limited)
	mux.HandleFunc("PATCH /network-interfaces/{iface}", limited)
	mux.HandleFunc("PUT /logger", func(w http.ResponseWriter, _ *http.Request) {
		v.record(id, "logger")
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("PUT /snapshot/create", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		v.record(id, fmt.Sprintf("snapshot/create sync=%v", body["sync_snapshot_files"]))
		v.mu.Lock()
		paused, fail, takes, onCreate := v.state[id] == "Paused", v.failCreate, v.createTakes, v.onCreate
		v.mu.Unlock()
		if onCreate != nil {
			onCreate(id)
		}
		time.Sleep(takes)
		if !paused || fail {
			http.Error(w, `{"fault_message":"not paused"}`, http.StatusBadRequest)
			return
		}
		in := func(p any) string { return filepath.Join(root, strings.TrimPrefix(p.(string), "/")) }
		_ = os.WriteFile(in(body["snapshot_path"]), []byte("vmstate of "+id), 0o600)
		_ = os.WriteFile(in(body["mem_file_path"]), make([]byte, memMB(args)<<20), 0o600)
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("PUT /snapshot/load", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		v.record(id, "snapshot/load")
		v.mu.Lock()
		if v.loads == nil {
			v.loads = map[string]map[string]any{}
		}
		v.loads[id] = body
		v.state[id] = "Running"
		v.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = srv.Serve(apiL) }()
	ws := v.t.TempDir()
	gfs, err := guest.OpenRoot(ws)
	if err != nil {
		return err
	}
	vsL, err := net.Listen("unix", filepath.Join(root, "v.sock"))
	if err != nil {
		return err
	}
	go func() {
		for {
			c, err := vsL.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				b := make([]byte, 14)
				n, _ := io.ReadFull(c, b[:13])
				switch string(b[:n]) {
				case "CONNECT 1024\n":
					_, _ = io.WriteString(c, "OK 1073741824\n")
					_ = guest.Serve(life, c, c, gfs)
				case "CONNECT 1023\n":
					_, _ = io.WriteString(c, "OK 1073741825\n")
					v.serveControl(id, c)
				}
			}()
		}
	}()
	v.mu.Lock()
	v.listen = append(v.listen, apiL, vsL)
	v.mu.Unlock()
	return nil
}

// serveControl plays the guest's init on the control port: it records the
// request and answers as init would, refusing v.refuse.
func (v *fakeVMM) serveControl(id string, c net.Conn) {
	var req guestinit.ControlRequest
	if err := guestinit.ReadControl(c, &req); err != nil {
		return
	}
	v.record(id, "control "+string(req.Op))
	v.mu.Lock()
	if v.controls == nil {
		v.controls = map[string][]guestinit.ControlRequest{}
	}
	v.controls[id] = append(v.controls[id], req)
	refuse := v.refuse == req.Op
	v.mu.Unlock()
	rep := guestinit.ControlReply{OK: !refuse}
	if refuse {
		rep.Error = "a sandbox snapshot holds no process of its workload; running: python3(77)"
	}
	if req.Rebirth != nil {
		rep.BootID, rep.UnixNano = req.Rebirth.BootID, time.Now().UnixNano()
	}
	_ = guestinit.WriteControl(c, rep)
}

func (v *fakeVMM) close() {
	v.mu.Lock()
	defer v.mu.Unlock()
	for _, l := range v.listen {
		_ = l.Close()
	}
}

func fakeKit(t *testing.T) *kit.Kit {
	t.Helper()
	dir := t.TempDir()
	for p, body := range map[string]string{kit.Layout.Firecracker: "fc", kit.Layout.Jailer: "jailer", kit.Layout.Kernel: "vmlinux", kit.Layout.KernelConfig: "cfg", kit.Layout.Rootfs["sandbox"]: "sandbox ext4"} {
		full := filepath.Join(dir, p)
		_ = os.MkdirAll(filepath.Dir(full), 0o755)
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	digest, err := kit.Make(dir, "x86_64", "v1.17.0", "6.1.188")
	if err != nil {
		t.Fatal(err)
	}
	k, err := kit.Load(dir, digest, "x86_64")
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func copyFile(src, dst string) error {
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, b, 0o600)
}

// newBackend is the backend on a fake host; its state lives under /tmp so
// the jail's unix socket paths fit darwin's bound.
func newBackend(t *testing.T, vmm *fakeVMM, n *fakeNet) *Backend {
	t.Helper()
	state, err := os.MkdirTemp("/tmp", "fc")
	if err != nil {
		t.Skip("no /tmp:", err)
	}
	t.Cleanup(func() { vmm.close(); _ = os.RemoveAll(state) })
	cg := t.TempDir()
	_ = os.WriteFile(filepath.Join(cg, "cgroup.controllers"), []byte("cpuset cpu io memory pids"), 0o644)
	b, err := New(Config{
		Kit: fakeKit(t), StateDir: state, Network: n, Host: isolation.Host{KVM: true, Arch: "x86_64"},
		CgroupRoot: cg, Launcher: vmm,
		Checks: &Checks{
			EUID: func() int { return 0 }, LookPath: func(s string) (string, error) { return "/usr/sbin/" + s, nil },
			Stat: func(string) (os.FileInfo, error) { return charDevice{}, nil }, ReadFile: os.ReadFile, Reflink: copyFile, Chown: func(string, int, int) error { return nil },
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

type charDevice struct{ os.FileInfo }

func (charDevice) Mode() fs.FileMode { return fs.ModeDevice | fs.ModeCharDevice | 0o666 }

// A sandbox machine boots in its own jail with a read-only clone of the
// base, answers its guest agent over vsock, pauses and resumes through the
// VMM, and Destroy leaves nothing: no record, no jail, no tap, no guest.
func TestAMachineIsReachedOverVsockAndDestroyedWithItsTapDiskAndJail(t *testing.T) {
	vmm := &fakeVMM{t: t, state: map[string]string{}, args: map[string][]string{}}
	n := &fakeNet{taps: map[string]hostnet.Attachment{}}
	b := newBackend(t, vmm, n)
	ctx := context.Background()
	m, err := b.Create(ctx, isolation.Spec{Shape: isolation.ShapeSandbox, Name: "kodus-claim-1-workload", Network: "kodus-claim-1", Memory: "512m", CPUs: "1", Labels: map[string]string{"kodus.cell": "c"}})
	if err != nil {
		t.Fatal(err)
	}
	if m.IP("kodus-claim-1") != "10.213.0.128" {
		t.Fatalf("address %+v", m)
	}
	root := b.rootDir(m.ID)
	fi, err := os.Stat(filepath.Join(root, "rootfs.ext4"))
	if err != nil || fi.Mode().Perm() != 0o400 {
		t.Fatalf("the sandbox's root clone: %v %v", fi, err)
	}
	if got, _ := os.ReadFile(filepath.Join(root, "rootfs.ext4")); string(got) != "sandbox ext4" {
		t.Fatalf("the root is not the kit's base: %q", got)
	}
	rw, err := b.DialGuest(ctx, "kodus-claim-1-workload")
	if err != nil {
		t.Fatal(err)
	}
	c := guest.NewClient(rw, "c", "claim-1")
	if r, err := c.Do(ctx, guest.NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindStat}); err != nil || !r.Ok {
		t.Fatalf("the guest agent over vsock: %+v %v", r, err)
	}
	_ = c.Close()
	if err := b.Pause(ctx, "kodus-claim-1-workload"); err != nil || vmm.state[m.ID] != "Paused" {
		t.Fatalf("pause: %v %s", err, vmm.state[m.ID])
	}
	if err := b.Start(ctx, "kodus-claim-1-workload"); err != nil || vmm.state[m.ID] != "Running" {
		t.Fatalf("resume: %v %s", err, vmm.state[m.ID])
	}
	if rs, _ := b.Machines(); len(rs) != 1 || rs[0].Labels["kodus.cell"] != "c" || rs[0].IP != "10.213.0.128" {
		t.Fatalf("records %+v", rs)
	}
	if len(b.Remains("kodus-claim-1-workload")) == 0 {
		t.Fatal("a live machine leaves no trace, so an empty list later would prove nothing")
	}
	vmm.close()
	if err := b.Destroy(ctx, "kodus-claim-1-workload", isolation.DestroyOptions{}); err != nil {
		t.Fatal(err)
	}
	if left := b.Remains("kodus-claim-1-workload"); len(left) > 0 {
		t.Fatalf("left %v", left)
	}
	if len(n.taps) != 0 {
		t.Fatalf("taps left %v", n.taps)
	}
	if _, err := b.DialGuest(ctx, "kodus-claim-1-workload"); err == nil {
		t.Fatal("a destroyed machine's guest answers")
	}
	if err := b.Destroy(ctx, "kodus-claim-1-workload", isolation.DestroyOptions{}); err != nil {
		t.Fatalf("destroying twice: %v", err)
	}
}

// Two machines never share a VMM user, a jail or an address.
func TestTwoMachinesShareNoUserJailOrAddress(t *testing.T) {
	vmm := &fakeVMM{t: t, state: map[string]string{}, args: map[string][]string{}}
	b := newBackend(t, vmm, &fakeNet{taps: map[string]hostnet.Attachment{}})
	ctx := context.Background()
	one, err := b.Create(ctx, isolation.Spec{Shape: isolation.ShapeSandbox, Name: "kodus-a-workload", Network: "kodus-a"})
	if err != nil {
		t.Fatal(err)
	}
	two, err := b.Create(ctx, isolation.Spec{Shape: isolation.ShapeSandbox, Name: "kodus-b-workload", Network: "kodus-b"})
	if err != nil {
		t.Fatal(err)
	}
	ua, ub := argValues(vmm.args[one.ID], "--uid")[0], argValues(vmm.args[two.ID], "--uid")[0]
	if one.ID == two.ID || ua == ub || one.IP("kodus-a") == two.IP("kodus-b") {
		t.Fatalf("shared: %+v %+v uids %s %s", one, two, ua, ub)
	}
	if _, err := b.Create(ctx, isolation.Spec{Shape: isolation.ShapeSandbox, Name: "kodus-a-workload", Network: "kodus-a"}); err == nil {
		t.Fatal("a second machine of the same name")
	}
}

// A machine whose VMM does not start leaves nothing behind, and an
// environment on a kit with no environment base is unsupported, not booted
// on the sandbox's.
func TestAMachineThatCannotStartLeavesNothing(t *testing.T) {
	vmm := &fakeVMM{t: t, state: map[string]string{}, args: map[string][]string{}, fail: true}
	n := &fakeNet{taps: map[string]hostnet.Attachment{}}
	b := newBackend(t, vmm, n)
	ctx := context.Background()
	if _, err := b.Create(ctx, isolation.Spec{Shape: isolation.ShapeSandbox, Name: "kodus-c-workload", Network: "kodus-c"}); err == nil {
		t.Fatal("created")
	}
	if left := b.Remains("kodus-c-workload"); len(left) > 0 || len(n.taps) > 0 {
		t.Fatalf("left %v taps %v", left, n.taps)
	}
	if _, err := b.Create(ctx, isolation.Spec{Shape: isolation.ShapeEnvironment, Name: "kodus-c-env", Network: "kodus-c"}); !errors.Is(err, driver.ErrUnsupported) {
		t.Fatalf("an environment on a kit without its base: %v", err)
	}
}

// Destroy kills a machine's VMM only when the pid is still that VMM: its
// command line, as the jailer starts it, carries --id and the machine's id.
// It used to look for "--id=<id>", which the jailer never writes, so every
// Destroy left the VMM running and its cgroup busy.
func TestDestroyRecognisesTheJailersVMMByItsCommandLine(t *testing.T) {
	id := "kfc-107d20d201630e0c28f9"
	jailed := []byte("/firecracker\x00--id\x00" + id + "\x00--start-time-us\x00463946484\x00--api-sock\x00/api.sock\x00--config-file\x00/config.json\x00")
	if !isVMMOf(jailed, id) {
		t.Fatal("the jailer's VMM is not recognised")
	}
	for _, other := range [][]byte{
		[]byte("/firecracker\x00--id\x00kfc-0000000000000000000a\x00--api-sock\x00/api.sock\x00"),
		[]byte("/usr/bin/sleep\x00" + id + "\x00"),
		[]byte("/firecracker\x00--id\x00"),
	} {
		if isVMMOf(other, id) {
			t.Errorf("%q taken for %s's VMM", other, id)
		}
	}
}

// An environment's VMM may write to the end of its root and data disks; a
// sandbox's, whose root is read-only, no more than its log's bound. Every
// VMM used to get the log's 64 MiB, so an environment's first mkfs.ext4 on
// its data disk killed it with SIGXFSZ ("Shutting down VM after
// intercepting signal 25") before its guest agent came up.
func TestAnEnvironmentsVMMMayWriteItsWholeDisks(t *testing.T) {
	root, data := int64(1897922560), int64(40)<<30
	env := VM{DataDisk: true}.FileBytes(root, data)
	if env != data {
		t.Fatalf("an environment's VMM may write %d bytes of a %d-byte data disk", env, data)
	}
	args := Jail{ID: "kfc-1", MemoryMB: 2048, CPUs: 2, FileBytes: env}.Args()
	if rl := argValues(args, "--resource-limit"); !slices.Contains(rl, "fsize="+strconv.FormatInt(data, 10)) {
		t.Fatalf("the jailer's limits %v", rl)
	}
	if sb := (VM{ReadOnlyRoot: true}).FileBytes(root, data); sb != maxLogBytes {
		t.Fatalf("a sandbox's VMM may write %d bytes", sb)
	}
	// A snapshot's memory file is the VMM's to write: a 1 GiB sandbox held
	// to the log's 64 MiB would die on SIGXFSZ in its first snapshot.
	if sb := (VM{ReadOnlyRoot: true, MemoryMB: 1024}).FileBytes(root, data); sb != 1<<30 {
		t.Fatalf("a 1 GiB sandbox's VMM may write %d bytes, not its memory file", sb)
	}
}

// The VMM's room for its page cache grows with the guest: the kernel lets a
// cgroup keep dirty about a fifth of what it could cache before the guest
// touched its memory, plus what is in writeback, and that must still fit
// once the guest's memory is all touched (S-09 OOM-killed a 2 GiB guest's
// VMM with a flat 512 MiB).
func TestTheVMMsCacheRoomOutgrowsWhatTheKernelLetsStayDirty(t *testing.T) {
	for _, guest := range []int{128, 512, 1024, 2048, 4096, 16384} {
		limit := guest + vmmOverheadMB + vmmCacheMB(guest)
		dirty := limit / 5      // vm.dirty_ratio 20 of a cgroup whose guest touched nothing yet
		writeback := limit / 16 // 150 MB in writeback against 2688 MiB, sampled on the KVM host
		if room := vmmCacheMB(guest); room < dirty+writeback/2 || room < vmmCacheMinMB {
			t.Errorf("a %d MiB guest: room %d MiB, dirty up to %d MiB and %d MiB in writeback", guest, room, dirty, writeback)
		}
		args := Jail{ID: "kfc-x", Exec: "/fc", UID: 1, GID: 1, ChrootBase: "/j", CgroupParent: "p", MemoryMB: guest, CPUs: 1}.Args()
		if got := memMB(args); got != guest {
			t.Errorf("memory.max of a %d MiB guest reads back as %d", guest, got)
		}
	}
}
