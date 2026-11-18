//go:build !linux

package claimlimits

import "context"

func NewSystemd(context.Context, string, string) (Lifecycle, error) { return nil, ErrUnavailable }
