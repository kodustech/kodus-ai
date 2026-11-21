package tarball

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type blipRevoker struct {
	calls int
	fail  int
}

func (c *blipRevoker) Revoke(context.Context, string) error {
	c.calls++
	if c.calls <= c.fail {
		return errors.New("blip")
	}
	return nil
}

// A token no fetch took is revoked with the same tries, past a cancelled
// context, and an error says so when every try fails.
func TestRevokeTriesAgainAndOutlivesItsContext(t *testing.T) {
	saved := revokeBackoff
	revokeBackoff = time.Millisecond
	t.Cleanup(func() { revokeBackoff = saved })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := &blipRevoker{fail: 1}
	if err := Revoke(ctx, r, "tok"); err != nil || r.calls != 2 {
		t.Fatalf("err %v after %d calls", err, r.calls)
	}
	r = &blipRevoker{fail: revokeAttempts}
	if err := Revoke(ctx, r, "tok"); err == nil || !strings.Contains(err.Error(), "token revocation") || r.calls != revokeAttempts {
		t.Fatalf("err %v after %d calls", err, r.calls)
	}
}
