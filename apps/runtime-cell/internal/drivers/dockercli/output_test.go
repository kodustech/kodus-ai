package dockercli

import (
	"context"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// A build's stderr reaches the claim's progress sink line by line, and still
// goes into the error a failure returns.
func TestExecCommandHandsStderrLinesToTheSink(t *testing.T) {
	var got []string
	ctx := driver.WithOutput(context.Background(), func(l string) { got = append(got, l) })
	_, err := ExecCommandWith(nil)(ctx, nil, "sh", "-c", "printf '#1 load\\n#2 RUN apk add\\r\\n' >&2; printf 'no newline' >&2; exit 3")
	if err == nil || !strings.Contains(err.Error(), "#2 RUN apk add") {
		t.Fatalf("err %v", err)
	}
	if len(got) != 3 || got[0] != "#1 load" || got[1] != "#2 RUN apk add" || got[2] != "no newline" {
		t.Fatalf("lines %q", got)
	}
}
