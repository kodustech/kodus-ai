package redact

import (
	"encoding/json"
	"unicode/utf8"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// Protocol limits the redacted text must still fit (libs/runtime/protocol).
const (
	MaxExecStream   = 16384
	MaxStreamChunk  = 65536
	MaxReason       = 4096
	MaxBundleLine   = 2048
	MaxBlockMessage = 4096
	MaxLogTailText  = 512
)

// StepResult redacts every text field of a step.result in place (exec
// output, the probe's HTTP body and headers, SQL cells, browser DOM, console
// and URLs, the observer's request log) and records the count.
func (r *Redactor) StepResult(b *protocol.StepResultBody) int {
	n := 0
	str := func(s *string) {
		var c int
		*s, c = r.String(*s)
		n += c
	}
	priorExploration := int64(0)
	if b.BrowserExploration != nil && b.Redactions != nil && *b.Redactions > 0 && *b.Redactions <= 1_000_000 {
		priorExploration = *b.Redactions
	}
	if exploration := b.BrowserExploration; exploration != nil {
		str(&exploration.Snapshot)
		var cut bool
		exploration.Snapshot, cut = Clip(exploration.Snapshot, 8000)
		exploration.Truncated = exploration.Truncated || cut
		kept := make([]protocol.BrowserExploreCandidate, 0, len(exploration.Candidates))
		for _, candidate := range exploration.Candidates {
			_, count := r.String(candidate.Selector)
			n += count
			if count > 0 || len(kept) >= 32 {
				exploration.Truncated = true
				continue // changing a selector would point at a different element
			}
			if candidate.Role != nil {
				str(candidate.Role)
				*candidate.Role, _ = Clip(*candidate.Role, 64)
			}
			if candidate.Name != nil {
				str(candidate.Name)
				*candidate.Name, _ = Clip(*candidate.Name, 256)
			}
			kept = append(kept, candidate)
		}
		exploration.Candidates = kept
	}
	if e := b.Exec; e != nil {
		str(&e.Stdout)
		str(&e.Stderr)
		var cut bool
		if e.Stdout, cut = Clip(e.Stdout, MaxExecStream); cut {
			e.Truncated = true
		}
		if e.Stderr, cut = Clip(e.Stderr, MaxExecStream); cut {
			e.Truncated = true
		}
	}
	if p := b.Probe; p != nil {
		if h := p.HTTP; h != nil {
			str(&h.Body)
			// Header names too: the app chooses them.
			red := make(map[string]string, len(h.Headers))
			for k, v := range h.Headers {
				rk, c1 := r.String(k)
				rv, c2 := r.String(v)
				n += c1 + c2
				red[rk] = rv
			}
			h.Headers = red
		}
		if q := p.SQL; q != nil {
			for i := range q.Columns {
				str(&q.Columns[i])
			}
			for _, row := range q.Rows {
				for i, cell := range row {
					if red, c := r.sqlCell(cell); c > 0 {
						n += c
						row[i] = red
					}
				}
			}
		}
		if br := p.Browser; br != nil {
			if br.DOM != nil {
				str(br.DOM)
			}
			for i := range br.Console {
				str(&br.Console[i].Text)
			}
			for i := range br.Network {
				str(&br.Network[i].URL)
			}
		}
		for i := range p.Requests {
			str(&p.Requests[i].Route)
		}
		if ev := p.Evidence; ev != nil {
			// The capture redacted these already (agent/evidence.go); this is the last pass.
			if l := ev.Logs; l != nil {
				for i := range l.Tail {
					str(&l.Tail[i].Service)
					l.Tail[i].Service, _ = Clip(l.Tail[i].Service, 128)
					str(&l.Tail[i].Text)
					l.Tail[i].Text, _ = Clip(l.Tail[i].Text, MaxLogTailText)
				}
			}
			if d := ev.Db; d != nil {
				str(&d.Service)
				d.Service, _ = Clip(d.Service, 128)
				for i := range d.Tables {
					str(&d.Tables[i].Table)
					d.Tables[i].Table, _ = Clip(d.Tables[i].Table, 256)
				}
				for si := range d.Sample {
					for _, row := range d.Sample[si].Rows {
						for i, cell := range row {
							if red, c := r.sqlCell(cell); c > 0 {
								n += c
								row[i] = red
							}
						}
					}
				}
			}
			if o := ev.Outbound; o != nil {
				for i := range o.Calls {
					str(&o.Calls[i].Host)
					o.Calls[i].Host, _ = Clip(o.Calls[i].Host, 253)
				}
			}
		}
	}
	count := int64(n) + priorExploration
	b.Redactions = &count
	return n
}

// sqlCell redacts one SQL cell. A string is redacted as text. Anything
// else (a number that is a known PIN, a jsonb object or array carrying a
// token) is redacted over its JSON text; when that changed it, the cell
// becomes the redacted text as a JSON string.
func (r *Redactor) sqlCell(cell json.RawMessage) (json.RawMessage, int) {
	var s string
	if json.Unmarshal(cell, &s) == nil {
		red, c := r.String(s)
		if c == 0 {
			return cell, 0
		}
		b, _ := json.Marshal(red)
		return b, c
	}
	red, c := r.String(string(cell))
	if c == 0 {
		return cell, 0
	}
	b, _ := json.Marshal(red)
	return b, c
}

// StepStream redacts one chunk. A value split across two chunks is not
// seen by either (see the plan's Dúvidas); the cell sends no stream today.
func (r *Redactor) StepStream(b *protocol.StepStreamBody) int {
	var n int
	b.Chunk, n = r.String(b.Chunk)
	b.Chunk, _ = Clip(b.Chunk, MaxStreamChunk)
	return n
}

// Clip cuts s to at most max bytes on a rune boundary.
// ClipMiddle keeps the start and the end of s within max bytes, never
// cutting a UTF-8 sequence: a failure's reason names the step first and
// says what failed last (a build's error is its final lines).
func ClipMiddle(s string, max int) (string, bool) {
	if len(s) <= max {
		return s, false
	}
	const sep = " … "
	head, _ := Clip(s, max/4)
	start := len(s) - (max - len(head) - len(sep))
	for start < len(s) && !utf8.RuneStart(s[start]) {
		start++
	}
	return head + sep + s[start:], true
}

func Clip(s string, max int) (string, bool) {
	if len(s) <= max {
		return s, false
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut], true
}
