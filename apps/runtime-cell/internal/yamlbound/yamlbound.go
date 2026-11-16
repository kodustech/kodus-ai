// Package yamlbound bounds the YAML a pull request hands the cell before the
// cell parses it in its own process: the compose files and the recipe
// (review #3). yaml.v3 turns its input into a node tree about a hundred
// times its size, and an alias expands a node once per use, so an unbounded
// file is the cell's memory, outside any claim's cgroup. Every file is read
// at most MaxFileBytes, and a document whose nodes, aliases expanded, pass
// MaxNodes is refused before it is decoded into maps.
package yamlbound

import (
	"errors"
	"fmt"
	"io"
	"os"
	"syscall"

	"go.yaml.in/yaml/v3"
)

// ErrTooLarge is a file or a document past the bounds. Its message says
// which bound, for the claim's blocker.
var ErrTooLarge = errors.New("too large for the cell")

const (
	// MaxFileBytes bounds one compose file or recipe (a Dockerfile is held
	// to the same, agent/checkout/imagepins.go).
	MaxFileBytes = 1 << 20
	// MaxNodes bounds one document's nodes, every alias counted as the
	// nodes it expands to. A real compose file has a few thousand.
	MaxNodes = 100_000
)

// ReadFile reads name inside root: a regular file (the one opened, so a FIFO
// or a device is refused and never waited on) of at most MaxFileBytes.
// Every path step stays inside root (os.Root).
func ReadFile(root *os.Root, name string) ([]byte, error) {
	f, err := root.OpenFile(name, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", name)
	}
	if info.Size() > MaxFileBytes {
		return nil, tooLargeFile(name)
	}
	b, err := io.ReadAll(io.LimitReader(f, MaxFileBytes+1))
	if err != nil {
		return nil, err
	}
	if len(b) > MaxFileBytes {
		return nil, tooLargeFile(name)
	}
	return b, nil
}

func tooLargeFile(name string) error {
	return fmt.Errorf("%s is over 1 MiB, the most the cell reads of a compose file or recipe: %w", name, ErrTooLarge)
}

// Parse is b as a node tree, refused when b is over MaxFileBytes (before
// any parsing) or its nodes, aliases expanded, pass MaxNodes (before the
// caller decodes it).
func Parse(b []byte) (*yaml.Node, error) {
	if len(b) > MaxFileBytes {
		return nil, fmt.Errorf("the document is over 1 MiB, the most the cell reads of a compose file or recipe: %w", ErrTooLarge)
	}
	var node yaml.Node
	if err := yaml.Unmarshal(b, &node); err != nil {
		return nil, err
	}
	if err := checkNodes(&node); err != nil {
		return nil, err
	}
	return &node, nil
}

// Check is Parse for a caller that decodes b itself.
func Check(b []byte) error {
	_, err := Parse(b)
	return err
}

// checkNodes counts the tree's nodes as a decode visits them: an alias is
// the nodes of what it names, every time it is used. Each node is counted
// once (an anchor's count is kept), so the walk is linear in the tree.
func checkNodes(root *yaml.Node) error {
	const visiting = -1
	sizes := map[*yaml.Node]int{}
	var count func(n *yaml.Node) (int, error)
	count = func(n *yaml.Node) (int, error) {
		if n == nil {
			return 0, nil
		}
		if s, ok := sizes[n]; ok {
			if s == visiting {
				return 0, errors.New("yaml: an anchor contains an alias to itself")
			}
			return s, nil
		}
		sizes[n] = visiting
		total := 1
		if n.Kind == yaml.AliasNode {
			s, err := count(n.Alias)
			if err != nil {
				return 0, err
			}
			total += s
		}
		for _, c := range n.Content {
			if total > MaxNodes {
				break
			}
			s, err := count(c)
			if err != nil {
				return 0, err
			}
			total += s
		}
		if total > MaxNodes {
			return 0, fmt.Errorf("the document expands to more than %d YAML nodes, the most the cell reads of a compose file or recipe: %w", MaxNodes, ErrTooLarge)
		}
		sizes[n] = total
		return total, nil
	}
	_, err := count(root)
	return err
}
