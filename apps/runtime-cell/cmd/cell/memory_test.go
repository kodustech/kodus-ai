package main

import (
	"errors"
	"strings"
	"testing"
)

func TestAllocatableMemory(t *testing.T) {
	host := func() (int, error) { return 15_800, nil }
	if mb, err := allocatableMemoryMB(0, 1024, host); err != nil || mb != 14_776 {
		t.Fatalf("host less reserve = %d, %v", mb, err)
	}
	if mb, err := allocatableMemoryMB(12_000, 1024, host); err != nil || mb != 12_000 {
		t.Fatalf("operator's figure = %d, %v", mb, err)
	}
	if _, err := allocatableMemoryMB(0, 16_000, host); err == nil {
		t.Fatal("a reserve above the host took")
	}
	if _, err := allocatableMemoryMB(0, 1024, func() (int, error) { return 0, errors.New("no meminfo") }); err == nil {
		t.Fatal("an unreadable host took")
	}
	if _, err := allocatableMemoryMB(-1, 1024, host); err == nil {
		t.Fatal("a negative figure took")
	}
}

func TestParseMemTotal(t *testing.T) {
	mb, err := parseMemTotalMB(strings.NewReader("MemTotal:       16179288 kB\nMemFree:  1 kB\n"))
	if err != nil || mb != 15_800 {
		t.Fatalf("MemTotal = %d, %v", mb, err)
	}
	if _, err := parseMemTotalMB(strings.NewReader("MemFree: 1 kB\n")); err == nil {
		t.Fatal("no MemTotal took")
	}
}
