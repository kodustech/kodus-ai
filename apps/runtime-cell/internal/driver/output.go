package driver

import "context"

type outputKey struct{}

// WithOutput carries a sink for the lines a long boot step prints (a
// build's progress, compose's own messages), so the agent can show a setup
// as it runs (claim.progress). The sink is called from the step's goroutine
// and must return quickly.
func WithOutput(ctx context.Context, sink func(line string)) context.Context {
	return context.WithValue(ctx, outputKey{}, sink)
}

// OutputFrom is the sink WithOutput set, or nil.
func OutputFrom(ctx context.Context) func(line string) {
	f, _ := ctx.Value(outputKey{}).(func(string))
	return f
}
