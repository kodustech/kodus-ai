package main

import "testing"

func TestNativeCleanupOwnershipRequiresBothLabelAndParent(t *testing.T) {
	uuid := "f6c8748c-d7f4-4d12-8bc8-039a8a8a10f2"
	parent := "kodus0366f44c3963-51ad661260c8fdb199ec58eb8355aa6161866a54d47eba3c6025d31fb36b1eaa.slice"
	for _, tc := range []struct {
		label, actual, expected string
		want                    bool
	}{
		{uuid, parent, parent, true}, {"", parent, parent, false}, {"other", parent, parent, false},
		{uuid, "system.slice", parent, false}, {uuid, parent, "", false}, {uuid, "", "", false},
	} {
		if got := ownsNativeContainer(tc.label, tc.actual, uuid, tc.expected); got != tc.want {
			t.Fatalf("ownership(%q,%q,%q)=%v", tc.label, tc.actual, tc.expected, got)
		}
	}
}
