package sandbox

import (
	"fmt"
	"strconv"
	"strings"
)

// The memory of a claim's services, by role (ADR-070 follow-up). A service
// that declares a limit (mem_limit, or deploy.resources.limits.memory) keeps
// it. On a cell with no aggregate parent (Options.MemShared) the claim's
// memory is what the services hold together, so the rest is split by what
// each service is, not evenly: a data store gets a small capped default, the
// app and what the file builds get the rest, and the sandbox keeps some
// headroom. An even split starved a large app next to a postgres, a mongo
// and a memcached that each took the same share and used a tenth of it.
const (
	// memHeadroomMinMB is what the claim keeps unallocated for the sandbox
	// itself (gVisor's own memory, the guest's page cache), up to a quarter of
	// the claim.
	memHeadroomMinMB = 256
	// dataStoreMB and heavyStoreMB are the default limit of a data store: a
	// cache or a database, and a search or analytics engine.
	dataStoreMB  = 512
	heavyStoreMB = 1024
	// appWeight and otherWeight split what is left: an app (a service with a
	// build, or one that publishes ports) takes four shares to the 1 of a
	// service that is neither.
	appWeight, otherWeight = 4, 1
)

type memRole int

const (
	roleOther memRole = iota
	roleApp
	roleData
)

// dataImages are image names (a substring of the repository's last path
// element) of the stores that keep state: the cell gives them a capped default.
var dataImages = []string{
	"postgres", "pgvector", "postgis", "mysql", "mariadb", "mongo", "redis", "valkey", "keydb", "memcached",
	"rabbitmq", "minio", "etcd", "nats", "couchdb", "influxdb",
}

// heavyImages need more than a cache does.
var heavyImages = []string{"elasticsearch", "opensearch", "clickhouse", "cassandra"}

// imageBase is the repository name of an image reference, lower case, with
// its registry, tag and digest cut off.
func imageBase(image string) string {
	image = strings.ToLower(image)
	if i := strings.Index(image, "@"); i >= 0 {
		image = image[:i]
	}
	if i := strings.LastIndex(image, "/"); i >= 0 {
		image = image[i+1:]
	}
	if i := strings.Index(image, ":"); i >= 0 {
		image = image[:i]
	}
	return image
}

func imageIn(image string, names []string) bool {
	base := imageBase(image)
	for _, n := range names {
		if strings.Contains(base, n) {
			return true
		}
	}
	return false
}

// hasNamedVolume says a service mounts one of the project's named volumes.
func hasNamedVolume(svc map[string]any) bool {
	vols, _ := svc["volumes"].([]any)
	for _, v := range vols {
		switch x := v.(type) {
		case string:
			if src, _, ok := strings.Cut(x, ":"); ok && src != "" && !isPath(src) {
				return true
			}
		case map[string]any:
			if t, _ := x["type"].(string); t == "volume" {
				if s, _ := x["source"].(string); s != "" {
					return true
				}
			}
		}
	}
	return false
}

func nonEmptyList(v any) bool {
	switch x := v.(type) {
	case []any:
		return len(x) > 0
	case map[string]any:
		return len(x) > 0
	}
	return false
}

// roleOf says what a service is for its memory, and the default limit of a
// data store in MB.
func roleOf(svc map[string]any) (memRole, int) {
	image, _ := svc["image"].(string)
	_, builds := svc["build"]
	switch {
	case builds:
		return roleApp, 0
	case imageIn(image, heavyImages):
		return roleData, heavyStoreMB
	case imageIn(image, dataImages):
		return roleData, dataStoreMB
	case nonEmptyList(svc["ports"]):
		return roleApp, 0
	case image != "" && hasNamedVolume(svc):
		return roleData, dataStoreMB
	}
	return roleOther, 0
}

// sizeBytes reads a memory value as a YAML file gives it: a number of bytes
// or a string with a unit.
func sizeBytes(v any) (int64, error) {
	switch x := v.(type) {
	case int:
		return int64(x), nil
	case int64:
		return x, nil
	case uint64:
		return int64(x), nil
	}
	return memBytes(v)
}

func mapAt(m map[string]any, keys ...string) map[string]any {
	for _, k := range keys {
		m, _ = m[k].(map[string]any)
	}
	return m
}

// declaredMem is the limit and the reservation a service declares: mem_limit
// first, then deploy.resources.limits.memory (and mem_reservation, then
// deploy.resources.reservations.memory). 0: none declared.
func declaredMem(name string, svc map[string]any) (limit, reserve int64, violations []Violation) {
	read := func(v any, path string) int64 {
		if v == nil {
			return 0
		}
		n, err := sizeBytes(v)
		if err != nil || n <= 0 {
			violations = append(violations, Violation{path, fmt.Sprintf("%v is not a memory size (4g, 512m)", v)})
			return 0
		}
		return n
	}
	p := "services." + name + "."
	if limit = read(svc["mem_limit"], p+"mem_limit"); limit == 0 {
		limit = read(mapAt(svc, "deploy", "resources", "limits")["memory"], p+"deploy.resources.limits.memory")
	}
	if reserve = read(svc["mem_reservation"], p+"mem_reservation"); reserve == 0 {
		reserve = read(mapAt(svc, "deploy", "resources", "reservations")["memory"], p+"deploy.resources.reservations.memory")
	}
	return limit, reserve, violations
}

// memPlan is the memory each service runs with.
type memPlan struct {
	// limit and reserve are mem_limit and mem_reservation per service, in
	// bytes; a service absent from limit keeps the claim's MemLimit.
	limit, reserve map[string]int64
	// declared is the sum of the limits the file declares, of the services
	// compose starts: what a ready claim may never be settled below.
	declared int64
}

func mib(b int64) string {
	if b%(1<<20) != 0 {
		return strconv.FormatInt(b, 10)
	}
	return strconv.FormatInt(b>>20, 10) + "m"
}

func (o Options) memoryRefusal(reason string) error {
	return &RefusedError{Violations: []Violation{{"services", reason}}}
}

// planMemory gives each service its memory. total is the claim's MemLimit
// (0: the cell sets none, and only the file's own values stand).
func (o Options) planMemory(services map[string]any) (memPlan, error) {
	p := memPlan{limit: map[string]int64{}, reserve: map[string]int64{}}
	var bad []Violation
	declared := map[string]int64{}
	for _, name := range sortedKeys(services) {
		svc, _ := services[name].(map[string]any)
		l, r, v := declaredMem(name, svc)
		bad = append(bad, v...)
		if l > 0 {
			declared[name] = l
		}
		if r > 0 {
			p.reserve[name] = r
		}
	}
	if len(bad) > 0 {
		return p, &RefusedError{Violations: bad}
	}
	started := startedNames(services)
	var total int64
	if o.MemLimit != "" {
		var err error
		if total, err = memBytes(o.MemLimit); err != nil {
			return p, fmt.Errorf("sandbox: memory limit %q: %w", o.MemLimit, err)
		}
	}
	var sum int64
	var named []string
	for _, name := range started {
		if l := declared[name]; l > 0 {
			sum += l
			named = append(named, fmt.Sprintf("%s %s", name, mib(l)))
		}
	}
	p.declared = sum
	for _, name := range sortedKeys(declared) {
		p.limit[name] = declared[name]
		if total > 0 && declared[name] > total {
			return p, o.memoryRefusal(fmt.Sprintf("%s declares %s, over the environment's machine size of %s: declare less or choose a larger machine size", name, mib(declared[name]), o.MemLimit))
		}
	}
	if total > 0 && o.MemShared && sum > total {
		return p, o.memoryRefusal(fmt.Sprintf("the services declare %s of memory together (%s), over the environment's machine size of %s: declare less or choose a larger machine size", mib(sum), strings.Join(named, ", "), o.MemLimit))
	}
	if total > 0 && o.MemShared {
		if err := o.shareRest(services, started, declared, total, &p); err != nil {
			return p, err
		}
	}
	for name, r := range p.reserve {
		if l, ok := p.limit[name]; ok && r > l {
			p.reserve[name] = l // docker refuses a reservation above the limit
		}
	}
	return p, nil
}

// shareRest gives the services that declare nothing their share of what the
// declared ones leave.
func (o Options) shareRest(services map[string]any, started []string, declared map[string]int64, total int64, p *memPlan) error {
	var data, rest []string
	caps := map[string]int64{}
	for _, name := range started {
		if declared[name] > 0 {
			continue
		}
		svc, _ := services[name].(map[string]any)
		role, def := roleOf(svc)
		if role == roleData {
			data = append(data, name)
			caps[name] = int64(def) << 20
		} else {
			rest = append(rest, name)
		}
	}
	n := len(data) + len(rest)
	if n == 0 {
		return nil
	}
	if n == 1 && len(declared) == 0 {
		return nil // a lone service has the whole claim, as it always had
	}
	pool := total - p.declared
	headroom := min(max(int64(memHeadroomMinMB)<<20, total/10), total/4)
	if pool-headroom >= int64(n)*int64(minServiceMemMB)<<20 {
		pool -= headroom
	}
	floor := int64(minServiceMemMB) << 20
	if pool < int64(n)*floor {
		return o.memoryRefusal(fmt.Sprintf("%d services without a memory limit (%s) share the %s the declared ones leave of the environment's machine size of %s, under %dm each: choose a larger machine size or declare mem_limit", n, strings.Join(append(append([]string{}, data...), rest...), ", "), mib(max(pool, 0)), o.MemLimit, minServiceMemMB))
	}
	dataBudget := pool
	if len(rest) > 0 {
		dataBudget = pool / 2
	}
	var used int64
	for _, name := range data {
		each := min(caps[name], max(dataBudget/int64(len(data)), floor))
		p.limit[name] = each >> 20 << 20
		used += p.limit[name]
	}
	if len(rest) > 0 {
		var weight int64
		for _, name := range rest {
			svc, _ := services[name].(map[string]any)
			if r, _ := roleOf(svc); r == roleApp {
				weight += appWeight
			} else {
				weight += otherWeight
			}
		}
		left := pool - used
		for _, name := range rest {
			svc, _ := services[name].(map[string]any)
			w := int64(otherWeight)
			if r, _ := roleOf(svc); r == roleApp {
				w = appWeight
			}
			p.limit[name] = max(left*w/weight, floor) >> 20 << 20
		}
	}
	return nil
}

// DeclaredMemory is the memory the compose file's services declare together
// (those compose starts), in bytes: the floor under which the claim's ceiling
// never goes. 0 when none declares one.
func DeclaredMemory(raw []byte, o Options) (int64, error) {
	c := &checker{o: o}
	doc, err := c.parse(raw)
	if err != nil {
		return 0, err
	}
	services, _ := doc["services"].(map[string]any)
	var sum int64
	for _, name := range startedNames(services) {
		svc, _ := services[name].(map[string]any)
		l, _, bad := declaredMem(name, svc)
		if len(bad) > 0 {
			return 0, &RefusedError{Violations: bad}
		}
		sum += l
	}
	return sum, nil
}
