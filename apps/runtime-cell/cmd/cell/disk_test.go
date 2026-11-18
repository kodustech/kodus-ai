package main

import "testing"

// The watchdog reads the data root's free space; 0 turns it off.
func TestDiskWatchReadsTheDataRoot(t *testing.T) {
	if diskWatch("/var/lib/docker", 0) != nil {
		t.Fatal("a zero floor made a watchdog")
	}
	w := diskWatch(t.TempDir(), 5)
	if w == nil || w.MinFreeBytes != 5<<30 {
		t.Fatalf("watch %+v", w)
	}
	if free, err := w.Free(); err != nil || free == 0 {
		t.Fatalf("free %d, %v", free, err)
	}
	if _, err := diskWatch("/no/such/dir", 5).Free(); err == nil {
		t.Fatal("a missing data root read as free")
	}
}
