package dockercli

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// DiskUsage is what Docker says its disk holds: each volume and each
// container's writable layer, with their labels.
type DiskUsage struct {
	Volumes    []DiskUser
	Containers []DiskUser
}

// DiskUser is one volume or container: its name (a volume's) or ID, its
// labels and its bytes on Docker's disk.
type DiskUser struct {
	Name   string
	Labels map[string]string
	Bytes  int64
}

// DiskUsage runs docker system df -v, which measures every volume: it can
// take a while on a busy host, so the caller bounds ctx and asks rarely.
func (c CLI) DiskUsage(ctx context.Context) (DiskUsage, error) {
	out, err := c.run(ctx, nil, "system", "df", "-v", "--format", "{{json .}}")
	if err != nil {
		return DiskUsage{}, err
	}
	type row struct {
		ID, Name, Labels, Size string
	}
	var doc struct {
		Containers, Volumes []row
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(out))), &doc); err != nil {
		return DiskUsage{}, fmt.Errorf("dockercli: system df: %w", err)
	}
	var du DiskUsage
	for _, r := range doc.Containers {
		du.Containers = append(du.Containers, DiskUser{Name: r.ID, Labels: labelPairs(r.Labels), Bytes: humanBytes(r.Size)})
	}
	for _, r := range doc.Volumes {
		du.Volumes = append(du.Volumes, DiskUser{Name: r.Name, Labels: labelPairs(r.Labels), Bytes: humanBytes(r.Size)})
	}
	return du, nil
}

// labelPairs reads the labels as docker's formatter writes them,
// "k=v,k=v".
func labelPairs(s string) map[string]string {
	out := map[string]string{}
	for _, kv := range strings.Split(s, ",") {
		if k, v, ok := strings.Cut(kv, "="); ok && k != "" {
			out[k] = v
		}
	}
	return out
}

// humanBytes reads a size as docker's formatter writes it (decimal units,
// "443.7kB", "1.14GB"); 0 for what it cannot read ("N/A").
func humanBytes(s string) int64 {
	units := []struct {
		suffix string
		mult   float64
	}{{"kB", 1e3}, {"MB", 1e6}, {"GB", 1e9}, {"TB", 1e12}, {"PB", 1e15}, {"B", 1}}
	for _, u := range units {
		if num, ok := strings.CutSuffix(s, u.suffix); ok {
			f, err := strconv.ParseFloat(num, 64)
			if err != nil || f < 0 {
				return 0
			}
			return int64(f*u.mult + 0.5)
		}
	}
	return 0
}
