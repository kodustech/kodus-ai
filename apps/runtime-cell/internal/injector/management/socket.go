package management

import (
	"net"
	"os"
	"path/filepath"
	"sync"
)

func privateParent(path string) (os.FileInfo, error) {
	if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, failure("unsafe_socket", 503)
	}
	parent := filepath.Dir(path)
	canonical, e := filepath.EvalSymlinks(parent)
	if e != nil || canonical != parent {
		return nil, failure("unsafe_socket", 503)
	}
	info, e := os.Lstat(parent)
	if e != nil || !info.IsDir() || info.Mode()&(os.ModePerm|os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0700 || info.Mode()&os.ModeSymlink != 0 {
		return nil, failure("unsafe_socket", 503)
	}
	uid, ok := fileUID(info)
	if !ok || uid != uint32(os.Geteuid()) {
		return nil, failure("unsafe_socket", 503)
	}
	return info, nil
}
func privateSocket(path string, parent os.FileInfo) (os.FileInfo, error) {
	now, e := privateParent(path)
	if e != nil || !os.SameFile(parent, now) {
		return nil, failure("unsafe_socket", 503)
	}
	info, e := os.Lstat(path)
	if e != nil || info.Mode()&os.ModeSocket == 0 || info.Mode()&(os.ModePerm|os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0600 {
		return nil, failure("unsafe_socket", 503)
	}
	uid, ok := fileUID(info)
	if !ok || uid != uint32(os.Geteuid()) {
		return nil, failure("unsafe_socket", 503)
	}
	return info, nil
}
func samePeer(c *net.UnixConn, uid uint32) error {
	got, e := peerUID(c)
	if e != nil || got != uid {
		return failure("denied", 403)
	}
	return nil
}

type ownedListener struct {
	*net.UnixListener
	path           string
	parent, socket os.FileInfo
	slots          chan struct{}
	check          func(*net.UnixConn) error
	once           sync.Once
}

func listenPrivate(path string) (*ownedListener, error) {
	return listenValidated(path, privateSocket)
}
func listenValidated(path string, validate func(string, os.FileInfo) (os.FileInfo, error)) (*ownedListener, error) {
	parent, e := privateParent(path)
	if e != nil {
		return nil, e
	}
	if _, e = os.Lstat(path); !os.IsNotExist(e) {
		return nil, failure("unsafe_socket", 503)
	}
	l, e := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if e != nil {
		return nil, failure("unsafe_socket", 503)
	}
	l.SetUnlinkOnClose(false)
	// The private parent excludes other OS users during chmod. Never replace or
	// unlink an existing node, including a stale socket from a previous process.
	createdInfo, e := os.Lstat(path)
	if e != nil {
		_ = l.Close()
		return nil, failure("unsafe_socket", 503)
	}
	cleanup := func() {
		_ = l.Close()
		if now, e := os.Lstat(path); e == nil && os.SameFile(createdInfo, now) {
			_ = os.Remove(path)
		}
	}
	if e = os.Chmod(path, 0600); e != nil {
		cleanup()
		return nil, failure("unsafe_socket", 503)
	}
	info, e := validate(path, parent)
	if e != nil {
		cleanup()
		return nil, e
	}
	return &ownedListener{UnixListener: l, path: path, parent: parent, socket: info, slots: make(chan struct{}, 8), check: func(c *net.UnixConn) error { return samePeer(c, uint32(os.Geteuid())) }}, nil
}
func (l *ownedListener) Accept() (net.Conn, error) {
	for {
		c, e := l.AcceptUnix()
		if e != nil {
			return nil, e
		}
		if l.check(c) != nil {
			_ = c.Close()
			continue
		}
		select {
		case l.slots <- struct{}{}:
			return &limitedConn{Conn: c, release: func() { <-l.slots }}, nil
		default:
			_ = c.Close()
		}
	}
}
func (l *ownedListener) Close() error {
	e := l.UnixListener.Close()
	l.once.Do(func() {
		parent, pe := privateParent(l.path)
		info, se := os.Lstat(l.path)
		if pe == nil && se == nil && os.SameFile(l.parent, parent) && os.SameFile(l.socket, info) {
			_ = os.Remove(l.path)
		}
	})
	return e
}

type limitedConn struct {
	net.Conn
	once    sync.Once
	release func()
}

func (c *limitedConn) Close() error { e := c.Conn.Close(); c.once.Do(c.release); return e }
