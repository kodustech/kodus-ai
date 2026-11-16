package resolver

import (
	"errors"
	"testing"
)

// In a pod the egress forwards to the cluster's DNS, named by the pod's
// resolv.conf: the chart cannot know its address. A host:port is kept.
func TestUpstreamAddrFromResolvConf(t *testing.T) {
	conf := func() ([]byte, error) {
		return []byte("search kodus-runtime-cell.svc.cluster.local svc.cluster.local\nnameserver 10.96.0.10\noptions ndots:5\n"), nil
	}
	if got, err := UpstreamAddr(UpstreamSystem, conf); err != nil || got != "10.96.0.10:53" {
		t.Fatalf("%s %v", got, err)
	}
	if got, _ := UpstreamAddr("169.254.169.253:53", nil); got != "169.254.169.253:53" {
		t.Fatalf("explicit %s", got)
	}
	if _, err := UpstreamAddr(UpstreamSystem, func() ([]byte, error) { return []byte("search x\n"), nil }); err == nil {
		t.Fatal("no nameserver accepted")
	}
	if _, err := UpstreamAddr(UpstreamSystem, func() ([]byte, error) { return nil, errors.New("absent") }); err == nil {
		t.Fatal("unreadable resolv.conf accepted")
	}
}
