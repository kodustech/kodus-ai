// Package asciicast writes a terminal recording in the asciicast v2 layout
// (https://docs.asciinema.org/manual/asciicast/v2/), with no library: one
// JSON header line, then one JSON array per event, [seconds, code, data].
// The cell replays a repository test's output with it (EVIDENCE-CAPTURE-
// DESIGN "Test replay"). It writes what it is given; redacting the text is
// the caller's job.
package asciicast

import (
	"bytes"
	"encoding/json"
	"strconv"
	"time"
	"unicode/utf8"
)

// Event codes of asciicast v2.
const (
	Output = "o"
	Marker = "m"
)

// Cast is a bounded recording: past Max bytes it keeps what it has and says
// it was cut.
type Cast struct {
	Max       int
	buf       bytes.Buffer
	truncated bool
	events    int
}

// New starts a cast with its header line: terminal size and when it started.
func New(width, height int, start time.Time, max int) *Cast {
	c := &Cast{Max: max}
	header, _ := json.Marshal(struct {
		Version   int               `json:"version"`
		Width     int               `json:"width"`
		Height    int               `json:"height"`
		Timestamp int64             `json:"timestamp"`
		Env       map[string]string `json:"env"`
	}{2, width, height, start.Unix(), map[string]string{"TERM": "xterm-256color"}})
	c.buf.Write(header)
	c.buf.WriteByte('\n')
	return c
}

// Add appends one event at offset since the start; an event that does not
// fit is cut to what fits (on a rune boundary) and the cast is marked cut.
func (c *Cast) Add(offset time.Duration, code, data string) {
	if c.truncated || data == "" {
		return
	}
	line := c.line(offset, code, data)
	if room := c.Max - c.buf.Len(); len(line) > room {
		c.truncated = true
		// Shrink the data until the line fits; JSON escaping makes the size non-linear.
		for len(data) > 0 && len(line) > room {
			cut := max(len(data)-(len(line)-room), 0)
			for cut > 0 && !utf8.RuneStart(data[cut]) {
				cut--
			}
			if cut == len(data) {
				cut--
			}
			data = data[:max(cut, 0)]
			line = c.line(offset, code, data)
		}
		if data == "" || len(line) > room {
			return
		}
	}
	c.buf.Write(line)
	c.events++
}

func (c *Cast) line(offset time.Duration, code, data string) []byte {
	d, _ := json.Marshal(data)
	sec := strconv.FormatFloat(max(offset, 0).Seconds(), 'f', 6, 64)
	return []byte("[" + sec + `,"` + code + `",` + string(d) + "]\n")
}

// Bytes is the recording so far.
func (c *Cast) Bytes() []byte { return c.buf.Bytes() }

// Truncated reports whether an event was cut or left out for the size.
func (c *Cast) Truncated() bool { return c.truncated }

// Events is how many events it holds.
func (c *Cast) Events() int { return c.events }
