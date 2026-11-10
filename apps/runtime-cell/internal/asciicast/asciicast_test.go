package asciicast

import (
	"bufio"
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestCastIsAsciicastV2(t *testing.T) {
	start := time.Unix(1_762_430_400, 0)
	c := New(120, 40, start, 1<<20)
	c.Add(1500*time.Millisecond, Output, "PASS cart.test.ts\r\n")
	c.Add(2*time.Second, Marker, "exit 0")
	sc := bufio.NewScanner(bytes.NewReader(c.Bytes()))
	var lines []string
	for sc.Scan() {
		lines = append(lines, sc.Text())
	}
	if len(lines) != 3 {
		t.Fatalf("%q", lines)
	}
	var h map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &h); err != nil || h["version"].(float64) != 2 || h["width"].(float64) != 120 || h["timestamp"].(float64) != 1_762_430_400 {
		t.Fatalf("header %s %v", lines[0], err)
	}
	var ev []any
	if err := json.Unmarshal([]byte(lines[1]), &ev); err != nil || ev[0].(float64) != 1.5 || ev[1] != "o" || ev[2] != "PASS cart.test.ts\r\n" {
		t.Fatalf("event %s %v", lines[1], err)
	}
	if c.Events() != 2 || c.Truncated() {
		t.Fatal(c.Events(), c.Truncated())
	}
}

// Past its bound the cast keeps what fits, stays valid line by line, and says it was cut.
func TestCastStaysWithinItsBound(t *testing.T) {
	c := New(80, 24, time.Unix(0, 0), 300)
	c.Add(0, Output, strings.Repeat("é\"x", 200))
	c.Add(time.Second, Output, "more")
	if len(c.Bytes()) > 300 || !c.Truncated() {
		t.Fatalf("%d bytes, truncated %v", len(c.Bytes()), c.Truncated())
	}
	for _, l := range strings.Split(strings.TrimRight(string(c.Bytes()), "\n"), "\n") {
		if !json.Valid([]byte(l)) {
			t.Fatalf("invalid line %q", l)
		}
	}
}
