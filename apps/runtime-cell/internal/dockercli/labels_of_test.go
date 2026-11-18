package dockercli

import (
	"context"
	"strings"
	"testing"
)

// LabelsOf lists every container's labels in one docker ps. A label value
// with a newline or a quote cannot make a second container or another
// label: docker prints each value through json, and a line that is not one
// container refuses the whole listing.
func TestLabelsOfListsEveryContainerInOneCall(t *testing.T) {
	calls := 0
	out := `{"id":"a1","names":"kodus-c-workload","labels":["","cell-1"]}
{"id":"b2","names":"kodus-c-workload-app-1,legacy/link","labels":["kodus-c-workload","cell-2\n{\"id\":\"x\"}"]}
`
	c := CLI{Run: func(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
		calls++
		if args[0] != "ps" || !strings.Contains(strings.Join(args, " "), `(.Label "kodus.cell")`) {
			t.Errorf("args %q", args)
		}
		return []byte(out), nil
	}}
	got, err := c.LabelsOf(context.Background(), "com.docker.compose.project", "kodus.cell")
	if err != nil || calls != 1 || len(got) != 2 {
		t.Fatalf("got %+v %v after %d calls", got, err, calls)
	}
	if got[1].Labels["kodus.cell"] != "cell-2\n{\"id\":\"x\"}" || got[1].Labels["com.docker.compose.project"] != "kodus-c-workload" || len(got[1].Names) != 2 {
		t.Fatalf("second container %+v", got[1])
	}
	out = "{\"id\":\"a1\",\"names\":\"n\",\"labels\":[\"\"]}\n"
	if _, err := c.LabelsOf(context.Background(), "com.docker.compose.project", "kodus.cell"); err == nil {
		t.Fatal("a line with fewer labels than asked was taken")
	}
}
