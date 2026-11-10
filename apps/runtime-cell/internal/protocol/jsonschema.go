package protocol

import (
	"encoding/json"
	"fmt"
	"math/big"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

// A JSON Schema validator for exactly the keywords protocolJsonSchemas()
// emits. It runs on the tree parseStrict builds, so object keys are compared
// byte for byte: "cellid" is an unknown key, not a spelling of "cellId".
type node struct {
	Type          string
	Properties    map[string]*node
	Required      []string
	Closed        bool  // additionalProperties: false
	Additional    *node // additionalProperties: {schema}
	PropertyNames *node
	Enum          []any
	Const         any
	HasConst      bool
	AnyOf         []*node
	Items         *node
	ItemsFalse    bool // items: false, a closed tuple
	PrefixItems   []*node
	MinItems      *int
	MaxItems      *int
	MinLength     *int
	MaxLength     *int
	Minimum       *big.Float
	Maximum       *big.Float
	Pattern       *regexp.Regexp
}

func compileSchema(raw json.RawMessage) (*node, error) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	n := &node{}
	for k, v := range m {
		var err error
		switch k {
		case "type":
			err = json.Unmarshal(v, &n.Type)
		case "properties":
			var props map[string]json.RawMessage
			if err = json.Unmarshal(v, &props); err == nil {
				n.Properties = map[string]*node{}
				for name, ps := range props {
					if n.Properties[name], err = compileSchema(ps); err != nil {
						return nil, err
					}
				}
			}
		case "required":
			err = json.Unmarshal(v, &n.Required)
		case "additionalProperties":
			if string(v) == "false" {
				n.Closed = true
			} else if len(v) > 0 && v[0] == '{' {
				n.Additional, err = compileSchema(v)
			}
		case "propertyNames":
			n.PropertyNames, err = compileSchema(v)
		case "enum":
			err = json.Unmarshal(v, &n.Enum)
		case "const":
			n.HasConst = true
			err = json.Unmarshal(v, &n.Const)
		case "anyOf":
			var list []json.RawMessage
			if err = json.Unmarshal(v, &list); err == nil {
				for _, x := range list {
					c, cerr := compileSchema(x)
					if cerr != nil {
						return nil, cerr
					}
					n.AnyOf = append(n.AnyOf, c)
				}
			}
		case "items":
			if string(v) == "false" {
				n.ItemsFalse = true
			} else if len(v) > 0 && v[0] == '{' {
				n.Items, err = compileSchema(v)
			}
		case "prefixItems":
			var list []json.RawMessage
			if err = json.Unmarshal(v, &list); err == nil {
				for _, x := range list {
					c, cerr := compileSchema(x)
					if cerr != nil {
						return nil, cerr
					}
					n.PrefixItems = append(n.PrefixItems, c)
				}
			}
		case "minItems":
			n.MinItems = new(int)
			err = json.Unmarshal(v, n.MinItems)
		case "maxItems":
			n.MaxItems = new(int)
			err = json.Unmarshal(v, n.MaxItems)
		case "minLength":
			n.MinLength = new(int)
			err = json.Unmarshal(v, n.MinLength)
		case "maxLength":
			n.MaxLength = new(int)
			err = json.Unmarshal(v, n.MaxLength)
		case "minimum", "maximum":
			f, ok := new(big.Float).SetString(string(v))
			if !ok {
				return nil, fmt.Errorf("bad %s %s", k, v)
			}
			if k == "minimum" {
				n.Minimum = f
			} else {
				n.Maximum = f
			}
		case "pattern":
			var p string
			if err = json.Unmarshal(v, &p); err == nil {
				n.Pattern, err = regexp.Compile(p)
			}
		case "$schema", "format":
			// format is backed by pattern in every place zod emits it.
		default:
			return nil, fmt.Errorf("unsupported schema keyword %q", k)
		}
		if err != nil {
			return nil, fmt.Errorf("%s: %w", k, err)
		}
	}
	return n, nil
}

type schemaError struct {
	path string
	msg  string
}

func (e *schemaError) Error() string {
	if e.path == "" {
		return e.msg
	}
	return e.path + ": " + e.msg
}

// jsLength counts UTF-16 code units, as zod's .min/.max on strings do.
func jsLength(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	if !utf8.ValidString(s) {
		return len(s)
	}
	return n
}

func typeOf(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case bool:
		return "boolean"
	case string:
		return "string"
	case json.Number:
		if isInteger(x) {
			return "integer"
		}
		return "number"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	}
	return fmt.Sprintf("%T", v)
}

func isInteger(n json.Number) bool {
	f, ok := new(big.Float).SetString(string(n))
	return ok && f.IsInt()
}

func equalJSON(a, b any) bool {
	switch x := a.(type) {
	case json.Number:
		y, ok := b.(float64)
		if !ok {
			return false
		}
		f, _ := new(big.Float).SetString(string(x))
		return f != nil && f.Cmp(big.NewFloat(y)) == 0
	case string:
		y, ok := b.(string)
		return ok && x == y
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	case nil:
		return b == nil
	}
	return false
}

func (n *node) validate(v any, path string) error {
	if len(n.AnyOf) > 0 {
		var first error
		for _, alt := range n.AnyOf {
			err := alt.validate(v, path)
			if err == nil {
				return nil
			}
			if first == nil {
				first = err
			}
		}
		return &schemaError{path, "no variant matched (" + first.Error() + ")"}
	}
	t := typeOf(v)
	if n.Type != "" && n.Type != t && !(n.Type == "number" && t == "integer") {
		return &schemaError{path, fmt.Sprintf("expected %s, got %s", n.Type, t)}
	}
	if n.HasConst && !equalJSON(v, n.Const) {
		return &schemaError{path, fmt.Sprintf("expected %v", n.Const)}
	}
	if len(n.Enum) > 0 {
		ok := false
		for _, e := range n.Enum {
			if equalJSON(v, e) {
				ok = true
				break
			}
		}
		if !ok {
			return &schemaError{path, fmt.Sprintf("value not in enum %v", n.Enum)}
		}
	}
	switch x := v.(type) {
	case string:
		l := jsLength(x)
		if n.MinLength != nil && l < *n.MinLength {
			return &schemaError{path, fmt.Sprintf("shorter than %d", *n.MinLength)}
		}
		if n.MaxLength != nil && l > *n.MaxLength {
			return &schemaError{path, fmt.Sprintf("longer than %d", *n.MaxLength)}
		}
		if n.Pattern != nil && !n.Pattern.MatchString(x) {
			return &schemaError{path, "does not match " + n.Pattern.String()}
		}
	case json.Number:
		f, _ := new(big.Float).SetString(string(x))
		if f == nil {
			return &schemaError{path, "bad number"}
		}
		if n.Minimum != nil && f.Cmp(n.Minimum) < 0 {
			return &schemaError{path, "below minimum " + n.Minimum.String()}
		}
		if n.Maximum != nil && f.Cmp(n.Maximum) > 0 {
			return &schemaError{path, "above maximum " + n.Maximum.String()}
		}
	case []any:
		if n.MinItems != nil && len(x) < *n.MinItems {
			return &schemaError{path, fmt.Sprintf("fewer than %d items", *n.MinItems)}
		}
		if n.MaxItems != nil && len(x) > *n.MaxItems {
			return &schemaError{path, fmt.Sprintf("more than %d items", *n.MaxItems)}
		}
		if len(n.PrefixItems) > 0 {
			// JSON Schema 2020-12: extra items are open unless items is false
			// (the TS dump closes every zod tuple with items: false).
			if n.ItemsFalse && len(x) > len(n.PrefixItems) {
				return &schemaError{path, fmt.Sprintf("tuple of %d items", len(n.PrefixItems))}
			}
			for i, item := range x {
				s := n.Items
				if i < len(n.PrefixItems) {
					s = n.PrefixItems[i]
				}
				if s == nil {
					continue
				}
				if err := s.validate(item, fmt.Sprintf("%s[%d]", path, i)); err != nil {
					return err
				}
			}
		} else if n.Items != nil {
			for i, item := range x {
				if err := n.Items.validate(item, fmt.Sprintf("%s[%d]", path, i)); err != nil {
					return err
				}
			}
		}
	case map[string]any:
		for _, r := range n.Required {
			if _, ok := x[r]; !ok {
				return &schemaError{joinPath(path, r), "required"}
			}
		}
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			child := x[k]
			if n.PropertyNames != nil {
				if err := n.PropertyNames.validate(k, joinPath(path, k)+"(key)"); err != nil {
					return err
				}
			}
			if ps, ok := n.Properties[k]; ok {
				if err := ps.validate(child, joinPath(path, k)); err != nil {
					return err
				}
				continue
			}
			if n.Additional != nil {
				if err := n.Additional.validate(child, joinPath(path, k)); err != nil {
					return err
				}
				continue
			}
			if n.Closed {
				return &schemaError{joinPath(path, k), "unknown key"}
			}
		}
	}
	return nil
}

func joinPath(path, key string) string {
	if path == "" {
		return key
	}
	if strings.ContainsAny(key, ".[") {
		return fmt.Sprintf("%s[%q]", path, key)
	}
	return path + "." + key
}
