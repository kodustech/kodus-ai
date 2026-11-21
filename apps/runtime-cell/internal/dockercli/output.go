package dockercli

import "context"

type outputKey struct{}

// WithOutput gives every command run under ctx a sink for its stderr lines
// (a build's progress, compose's own messages). It is how a driver tees the
// docker commands of one boot to the boot's driver.UpRequest.Output: the
// command runner's own plumbing, inside the adapter. A driver's inputs come
// in its requests, never through here. A nil sink stops the tee.
func WithOutput(ctx context.Context, sink func(line string)) context.Context {
	return context.WithValue(ctx, outputKey{}, sink)
}

// OutputFrom is the sink WithOutput set, or nil.
func OutputFrom(ctx context.Context) func(line string) {
	f, _ := ctx.Value(outputKey{}).(func(string))
	return f
}
