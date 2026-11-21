package egress

import (
	"io"
	"net"
	"sync"
	"testing"
	"time"
)

// BenchmarkRelayOneConnection relays one connection both ways through the
// counting wrappers, as serveConn does: what each connection allocates.
// Measured on an Apple M4 (-benchtime 2000x): before the pooled buffers
// 69.0 KB and 36 allocations per connection (two fresh 32 KiB buffers),
// after 3.6 KB and 34 (G3). What a live connection holds while it copies
// is unchanged: MaxConnsPerClaim and MaxConns bound that.
func BenchmarkRelayOneConnection(b *testing.B) {
	payload := make([]byte, 4<<10)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		vmSide, clientEnd := net.Pipe()
		upSide, serverEnd := net.Pipe()
		live := &liveConn{client: clientEnd, upstream: upSide}
		now := time.Now
		client := countingConn{Conn: clientEnd, n: &live.up, live: live, now: now}
		upstream := countingConn{Conn: upSide, n: &live.down, live: live, now: now}
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); splice(client, upstream) }()
		go func() {
			defer wg.Done()
			_, _ = io.ReadFull(serverEnd, payload)
			_, _ = serverEnd.Write(payload)
			_ = serverEnd.Close()
		}()
		_, _ = vmSide.Write(payload)
		_, _ = io.ReadFull(vmSide, payload)
		_ = vmSide.Close()
		wg.Wait()
	}
}
