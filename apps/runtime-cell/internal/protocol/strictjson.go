package protocol

import (
	"encoding/json"
	"fmt"
	"regexp"
)

// parseStrict mirrors libs/runtime/protocol/strict-json.ts: a frame that two
// parsers could read differently (duplicate key, nesting past maxDepth,
// trailing data) is refused before any schema runs (ADR-051, S-30). So is a
// reserved key (__proto__): in the TS decoder it would replace an object's
// prototype and hide a field from the strict schema.
// Objects become map[string]any, arrays []any, numbers json.Number.
func parseStrict(text string, maxDepth int) (any, error) {
	p := &strictParser{s: text, max: maxDepth}
	v, err := p.value(0)
	if err != nil {
		return nil, err
	}
	p.ws()
	if p.i != len(p.s) {
		return nil, p.fail(CodeInvalidJSON, "trailing data")
	}
	return v, nil
}

type strictParser struct {
	s   string
	i   int
	max int
}

var numberRe = regexp.MustCompile(`^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)`)

// reservedKeys are refused anywhere in a frame (strict-json.ts
// RESERVED_JSON_KEYS).
var reservedKeys = map[string]bool{"__proto__": true}

func (p *strictParser) fail(code DecodeErrorCode, msg string) error {
	return &DecodeError{Code: code, Message: fmt.Sprintf("%s at %d", msg, p.i)}
}

func (p *strictParser) ws() {
	for p.i < len(p.s) {
		switch p.s[p.i] {
		case ' ', '\t', '\n', '\r':
			p.i++
		default:
			return
		}
	}
}

func (p *strictParser) expect(c byte) error {
	if p.i >= len(p.s) || p.s[p.i] != c {
		return p.fail(CodeInvalidJSON, fmt.Sprintf("expected '%c'", c))
	}
	p.i++
	return nil
}

func (p *strictParser) str() (string, error) {
	start := p.i
	if err := p.expect('"'); err != nil {
		return "", err
	}
	for p.i < len(p.s) && p.s[p.i] != '"' {
		if p.s[p.i] == '\\' {
			p.i++
		}
		p.i++
	}
	if err := p.expect('"'); err != nil {
		return "", err
	}
	var out string
	if err := json.Unmarshal([]byte(p.s[start:p.i]), &out); err != nil {
		return "", p.fail(CodeInvalidJSON, "bad string")
	}
	return out, nil
}

func (p *strictParser) value(depth int) (any, error) {
	if depth > p.max {
		return nil, p.fail(CodeTooDeep, fmt.Sprintf("nesting deeper than %d", p.max))
	}
	p.ws()
	if p.i >= len(p.s) {
		return nil, p.fail(CodeInvalidJSON, "unexpected end")
	}
	switch p.s[p.i] {
	case '{':
		p.i++
		out := map[string]any{}
		p.ws()
		if p.i < len(p.s) && p.s[p.i] == '}' {
			p.i++
			return out, nil
		}
		for {
			p.ws()
			key, err := p.str()
			if err != nil {
				return nil, err
			}
			if _, dup := out[key]; dup {
				return nil, p.fail(CodeDuplicateKey, fmt.Sprintf("duplicate key %q", key))
			}
			if reservedKeys[key] {
				return nil, p.fail(CodeInvalidJSON, fmt.Sprintf("reserved key %q", key))
			}
			p.ws()
			if err := p.expect(':'); err != nil {
				return nil, err
			}
			v, err := p.value(depth + 1)
			if err != nil {
				return nil, err
			}
			out[key] = v
			p.ws()
			if p.i < len(p.s) && p.s[p.i] == ',' {
				p.i++
				continue
			}
			if err := p.expect('}'); err != nil {
				return nil, err
			}
			return out, nil
		}
	case '[':
		p.i++
		out := []any{}
		p.ws()
		if p.i < len(p.s) && p.s[p.i] == ']' {
			p.i++
			return out, nil
		}
		for {
			v, err := p.value(depth + 1)
			if err != nil {
				return nil, err
			}
			out = append(out, v)
			p.ws()
			if p.i < len(p.s) && p.s[p.i] == ',' {
				p.i++
				continue
			}
			if err := p.expect(']'); err != nil {
				return nil, err
			}
			return out, nil
		}
	case '"':
		return p.str()
	}
	// A number of any length reads whole, as the TS sticky regex reads it.
	m := numberRe.FindString(p.s[p.i:])
	if m == "" {
		return nil, p.fail(CodeInvalidJSON, "unexpected token")
	}
	p.i += len(m)
	switch m {
	case "true":
		return true, nil
	case "false":
		return false, nil
	case "null":
		return nil, nil
	}
	return json.Number(m), nil
}
