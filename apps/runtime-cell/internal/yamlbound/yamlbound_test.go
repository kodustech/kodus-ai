package yamlbound

import (
	"errors"
	"strings"
	"testing"
)

// An anchor whose content names itself is refused, not walked forever.
func TestAnAnchorThatContainsItselfIsRefused(t *testing.T) {
	if _, err := Parse([]byte("a: &x [1, *x]\n")); err == nil {
		t.Fatal("a self-referencing anchor parsed")
	}
}

// Shared anchors are counted once per use, as a decode expands them.
func TestAliasesCountAsWhatTheyExpandTo(t *testing.T) {
	list := "[" + strings.TrimSuffix(strings.Repeat("a, ", 1000), ", ") + "]"
	uses := strings.TrimSuffix(strings.Repeat("*l, ", 90), ", ")
	if _, err := Parse([]byte("l: &l " + list + "\nm: [" + uses + "]\n")); err != nil {
		t.Fatalf("about 92k nodes: %v", err)
	}
	uses = strings.TrimSuffix(strings.Repeat("*l, ", 110), ", ")
	if _, err := Parse([]byte("l: &l " + list + "\nm: [" + uses + "]\n")); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("about 112k nodes: %v", err)
	}
}
