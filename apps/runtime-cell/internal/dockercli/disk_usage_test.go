package dockercli

import (
	"context"
	"strings"
	"testing"
)

// The disk watchdog's measure of each claim's disk (R3-03): one docker
// system df, read as Docker writes it (sizes in decimal units, labels as
// k=v pairs).
func TestDiskUsageReadsVolumesAndWritableLayers(t *testing.T) {
	out := `{"Images":[],"Containers":[` +
		`{"ID":"c1","Labels":"com.docker.compose.project=m-1,kodus.claim=claim-a","Size":"20.5kB","State":"running"},` +
		`{"ID":"c2","Labels":"","Size":"0B"}],` +
		`"Volumes":[{"Name":"m-1_data","Labels":"com.docker.compose.project=m-1,com.docker.compose.volume=data","Size":"1.14GB"},` +
		`{"Name":"loose","Labels":"","Size":"N/A"}],"BuildCache":[]}`
	var args []string
	c := CLI{Run: func(_ context.Context, _ []byte, _ string, a ...string) ([]byte, error) {
		args = a
		return []byte(out + "\n"), nil
	}}
	got, err := c.DiskUsage(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(args, " ") != "system df -v --format {{json .}}" {
		t.Fatalf("docker %v", args)
	}
	if len(got.Containers) != 2 || got.Containers[0].Bytes != 20500 || got.Containers[0].Labels["kodus.claim"] != "claim-a" {
		t.Fatalf("containers %+v", got.Containers)
	}
	if len(got.Volumes) != 2 || got.Volumes[0].Bytes != 1_140_000_000 || got.Volumes[0].Labels["com.docker.compose.project"] != "m-1" || got.Volumes[1].Bytes != 0 {
		t.Fatalf("volumes %+v", got.Volumes)
	}
}

func TestHumanBytesReadsDockersSizes(t *testing.T) {
	for in, want := range map[string]int64{"0B": 0, "512B": 512, "443.7kB": 443700, "12.3MB": 12_300_000, "1.14GB": 1_140_000_000, "2TB": 2_000_000_000_000, "N/A": 0, "": 0} {
		if got := humanBytes(in); got != want {
			t.Errorf("%q: %d, want %d", in, got, want)
		}
	}
}
