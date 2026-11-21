//go:build linux

package guest

import "testing"

func TestTheGuestAgentIsNotDumpableOnceItStarts(t *testing.T) {
	if err := Undumpable(); err != nil {
		t.Fatal(err)
	}
	on, err := Dumpable()
	if err != nil {
		t.Fatal(err)
	}
	if on {
		t.Fatal("the guest agent is still dumpable: a command as its user can open its /proc fds")
	}
}
