package dockergvisor

import (
	"testing"
)

// Every compose service of a claim runs with the cell's log bound and, on a
// cell with a container disk size, that size on its writable layer: no PR
// service fills the shared Docker disk with logs or its layer (review #7).
func TestComposeServicesGetTheCellsDiskBounds(t *testing.T) {
	r := newGoldenRig(t, goldenCompose, goldenRecipe, func(c *Config) {
		c.ContainerDiskSize, c.ServiceLogMaxSize, c.ServiceLogMaxFile = "20G", "5m", 2
	})
	r.up(t)
	r.docker.mu.Lock()
	defer r.docker.mu.Unlock()
	if len(r.docker.rendered) == 0 {
		t.Fatal("no compose file rendered")
	}
	for _, doc := range r.docker.rendered {
		services, _ := doc["services"].(map[string]any)
		for name, s := range services {
			svc, _ := s.(map[string]any)
			logging, _ := svc["logging"].(map[string]any)
			opts, _ := logging["options"].(map[string]any)
			if logging["driver"] != "local" || opts["max-size"] != "5m" || opts["max-file"] != "2" {
				t.Errorf("%s logs %v", name, logging)
			}
			if so, _ := svc["storage_opt"].(map[string]any); so["size"] != "20G" {
				t.Errorf("%s storage_opt %v", name, svc["storage_opt"])
			}
		}
	}
}
