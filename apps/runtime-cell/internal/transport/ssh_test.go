package transport

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// vm is a minimal sshd: it accepts only the claim's client key, presents the
// claim's host key, and runs kody-exec or the upload tar.
type vm struct {
	addr     string
	mu       sync.Mutex
	commands []string
	uploaded []string
}

func startVM(t *testing.T, keys *ClaimKeys) *vm {
	t.Helper()
	authorized := keys.Client.PublicKey().Marshal()
	cfg := &ssh.ServerConfig{PublicKeyCallback: func(_ ssh.ConnMetadata, k ssh.PublicKey) (*ssh.Permissions, error) {
		if bytes.Equal(k.Marshal(), authorized) {
			return nil, nil
		}
		return nil, io.EOF
	}}
	cfg.AddHostKey(keys.Host)
	l, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	v := &vm{addr: l.Addr().String()}
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go v.serve(c, cfg)
		}
	}()
	return v
}

func (v *vm) serve(c net.Conn, cfg *ssh.ServerConfig) {
	_, chans, reqs, err := ssh.NewServerConn(c, cfg)
	if err != nil {
		return
	}
	go ssh.DiscardRequests(reqs)
	for nc := range chans {
		ch, creqs, err := nc.Accept()
		if err != nil {
			return
		}
		go func() {
			defer ch.Close()
			for req := range creqs {
				if req.Type != "exec" {
					_ = req.Reply(false, nil)
					continue
				}
				_ = req.Reply(true, nil)
				cmd := string(req.Payload[4:])
				v.mu.Lock()
				v.commands = append(v.commands, cmd)
				v.mu.Unlock()
				status := uint32(0)
				switch {
				case cmd == "/usr/local/bin/kody-exec":
					var r kodyexec.Request
					_ = json.NewDecoder(ch).Decode(&r)
					_ = json.NewEncoder(ch).Encode(kodyexec.Run(context.Background(), r))
				case strings.HasPrefix(cmd, "mkdir -p workspace && tar -x"):
					tr := tar.NewReader(ch)
					for {
						h, err := tr.Next()
						if err != nil {
							break
						}
						v.mu.Lock()
						v.uploaded = append(v.uploaded, h.Name)
						v.mu.Unlock()
					}
				case strings.HasPrefix(cmd, "mkdir -p hang "):
					select {} // reads nothing, never answers
				default:
					status = 127
				}
				b := make([]byte, 4)
				binary.BigEndian.PutUint32(b, status)
				_, _ = ch.SendRequest("exit-status", false, b)
				return
			}
		}()
	}
}

func ref(addr string) driver.MachineRef {
	host, port, _ := net.SplitHostPort(addr)
	_ = port
	return driver.MachineRef{MachineID: "i-1", PrivateAddress: host, Tags: map[string]string{driver.TagClaim: "claim-1"}}
}

func sshFor(addr string) *SSH {
	_, port, _ := net.SplitHostPort(addr)
	var p int
	for _, c := range port {
		p = p*10 + int(c-'0')
	}
	return &SSH{User: "runner", Port: p}
}

func TestSSHExecAndUploadWithPinnedHost(t *testing.T) {
	keys, _ := NewClaimKeys()
	v := startVM(t, keys)
	tr := sshFor(v.addr)
	tr.SetKeys("claim-1", keys)
	res, err := tr.Exec(context.Background(), ref(v.addr), kodyexec.Request{Command: "echo hi", TimeoutMs: 2000})
	if err != nil || res.Stdout != "hi\n" {
		t.Fatalf("%+v %v", res, err)
	}
	src := t.TempDir()
	_ = os.MkdirAll(filepath.Join(src, "src"), 0o755)
	_ = os.WriteFile(filepath.Join(src, "src", "a.js"), []byte("x"), 0o644)
	if err := tr.Upload(context.Background(), ref(v.addr), src, "workspace"); err != nil {
		t.Fatal(err)
	}
	if strings.Join(v.uploaded, ",") != "src/,src/a.js" {
		t.Fatalf("uploaded %v", v.uploaded)
	}
	if err := tr.Upload(context.Background(), ref(v.addr), src, "workspace; curl evil"); err == nil {
		t.Fatal("shell in the destination")
	}
	if !strings.HasPrefix(authorizedLine(keys), "ssh-ed25519 ") {
		t.Fatal("authorized key line")
	}
}

func authorizedLine(k *ClaimKeys) string { return k.AuthorizedKey() }

func TestSSHRefusesAnotherHostAndAnotherKey(t *testing.T) {
	keys, _ := NewClaimKeys()
	v := startVM(t, keys)
	// The agent expects another host key: a VM (or a man in the middle)
	// presenting a different host key is refused.
	other, _ := NewClaimKeys()
	tr := sshFor(v.addr)
	tr.SetKeys("claim-1", &ClaimKeys{Client: keys.Client, Host: other.Host, hostPublic: other.Host.PublicKey()})
	if _, err := tr.Exec(context.Background(), ref(v.addr), kodyexec.Request{Command: "id", TimeoutMs: 1000}); err == nil {
		t.Fatal("accepted an unpinned host key")
	}
	// Another claim's client key is not authorized on this VM.
	tr.SetKeys("claim-1", &ClaimKeys{Client: other.Client, Host: keys.Host, hostPublic: keys.Host.PublicKey()})
	if _, err := tr.Exec(context.Background(), ref(v.addr), kodyexec.Request{Command: "id", TimeoutMs: 1000}); err == nil {
		t.Fatal("another claim's key logged in")
	}
	tr.Forget("claim-1")
	if _, err := tr.Exec(context.Background(), ref(v.addr), kodyexec.Request{Command: "id", TimeoutMs: 1000}); err == nil {
		t.Fatal("ran without a key")
	}
}

func TestUserDataCarriesOnlyPublicClientKey(t *testing.T) {
	s := &SSH{User: "runner"}
	ud, err := s.PrepareClaim("claim-9")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(ud, "#cloud-config\n") || !strings.Contains(ud, "OPENSSH PRIVATE KEY") || !strings.Contains(ud, "- ssh-ed25519 ") || !strings.Contains(ud, "name: runner") {
		t.Fatalf("user-data:\n%s", ud)
	}
	// Exactly one private key: the VM's host key. The client key stays here.
	if strings.Count(ud, "PRIVATE KEY-----") != 2 {
		t.Fatal("more than one private key in user-data")
	}
}

// S-51: the host key the VM got in its user-data is a known value of the
// claim; printed by the VM in any wrapping it is redacted by the agent.
func TestClaimSecretsCoverTheHostKeyInUserData(t *testing.T) {
	s := &SSH{User: "runner"}
	ud, err := s.PrepareClaim("claim-9")
	if err != nil {
		t.Fatal(err)
	}
	known := s.ClaimSecrets("claim-9")
	if len(known) < 4 {
		t.Fatalf("known %d", len(known))
	}
	// The VM prints its user-data, then one base64 line of the key alone.
	pemLines := []string{}
	for _, l := range strings.Split(ud, "\n") {
		if l = strings.TrimSpace(l); len(l) >= 16 && !strings.Contains(l, " ") && !strings.HasPrefix(l, "-----") {
			pemLines = append(pemLines, l)
		}
	}
	out, n := redact.New(known...).String(ud + "\n" + pemLines[0])
	if n == 0 || strings.Contains(out, pemLines[0]) || !strings.Contains(out, "[redacted:ssh-host-key]") {
		t.Fatalf("host key left in output (%d):\n%s", n, out)
	}
	s.Forget("claim-9")
	if s.ClaimSecrets("claim-9") != nil {
		t.Fatal("keys outlived Forget")
	}
}

func uploadSource(t *testing.T, size int) string {
	t.Helper()
	src := t.TempDir()
	if err := os.WriteFile(filepath.Join(src, "big.bin"), bytes.Repeat([]byte("k"), size), 0o644); err != nil {
		t.Fatal(err)
	}
	return src
}

func tarWriterAlive() bool {
	buf := make([]byte, 1<<20)
	return strings.Contains(string(buf[:runtime.Stack(buf, true)]), "transport.writeTar")
}

// M10: when the remote side stops reading (tar failed), the tar writer used
// to block on the pipe forever, with the file open.
func TestUploadLeavesNoWriterWhenTheRemoteFails(t *testing.T) {
	keys, _ := NewClaimKeys()
	v := startVM(t, keys)
	tr := sshFor(v.addr)
	tr.SetKeys("claim-1", keys)
	if err := tr.Upload(context.Background(), ref(v.addr), uploadSource(t, 8<<20), "elsewhere"); err == nil {
		t.Fatal("a failed remote tar reported success")
	}
	deadline := time.Now().Add(2 * time.Second)
	for tarWriterAlive() && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if tarWriterAlive() {
		t.Fatal("the tar writer outlived the upload")
	}
}

// H5: an upload to a VM that never answers ends with its context.
func TestUploadEndsWithItsContext(t *testing.T) {
	keys, _ := NewClaimKeys()
	v := startVM(t, keys)
	tr := sshFor(v.addr)
	tr.SetKeys("claim-1", keys)
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- tr.Upload(ctx, ref(v.addr), uploadSource(t, 1<<10), "hang") }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("upload to a hung VM succeeded")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("upload ignored its context")
	}
}

func TestUploadDestinationIsAPlainRelativePath(t *testing.T) {
	tr := &SSH{User: "runner"}
	for _, dst := range []string{"", "/abs", "a/../b", "..", "./x", "w>x", "w*", "w x", "w$(id)", "w\nid"} {
		if err := tr.Upload(context.Background(), driver.MachineRef{}, t.TempDir(), dst); err == nil || !strings.Contains(err.Error(), "destination") {
			t.Fatalf("%q: %v", dst, err)
		}
	}
}
