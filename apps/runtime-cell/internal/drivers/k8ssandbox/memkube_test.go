package k8ssandbox

import (
	"context"
	"fmt"
	"sync"
)

// memKube is a cluster in memory: it keeps what the driver applies, merges
// a later apply into the object as server-side apply does, and deleting a
// namespace deletes what lives in it. Enough for the conformance suite to
// create, list, renew and destroy without a cluster.
type memKube struct {
	mu   sync.Mutex
	objs map[string]Object
}

func newMemKube(cluster ...Object) *memKube {
	k := &memKube{objs: map[string]Object{}}
	for _, o := range cluster {
		k.objs[key(o)] = o
	}
	return k
}

func meta(o Object) map[string]any {
	md, _ := o["metadata"].(map[string]any)
	return md
}

func key(o Object) string {
	md := meta(o)
	return fmt.Sprintf("%v/%v/%v", o["kind"], md["namespace"], md["name"])
}

func keyOf(kind, ns, name string) string {
	if ns == "" {
		return fmt.Sprintf("%s/<nil>/%s", kind, name)
	}
	return fmt.Sprintf("%s/%s/%s", kind, ns, name)
}

func merge(dst, src map[string]any) {
	for k, v := range src {
		if sub, ok := v.(map[string]any); ok {
			if cur, ok := dst[k].(map[string]any); ok {
				merge(cur, sub)
				continue
			}
		}
		dst[k] = v
	}
}

func (k *memKube) Apply(_ context.Context, o Object) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	if cur, ok := k.objs[key(o)]; ok {
		merge(cur, o)
		return nil
	}
	k.objs[key(o)] = o
	return nil
}

func (k *memKube) Get(_ context.Context, _, kind, ns, name string) (Object, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if o, ok := k.objs[keyOf(kind, ns, name)]; ok {
		return o, nil
	}
	return nil, ErrNotFound
}

func (k *memKube) Delete(_ context.Context, _, kind, ns, name string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	if _, ok := k.objs[keyOf(kind, ns, name)]; !ok {
		return ErrNotFound
	}
	delete(k.objs, keyOf(kind, ns, name))
	if kind == "Namespace" {
		for id, o := range k.objs {
			if meta(o)["namespace"] == name {
				delete(k.objs, id)
			}
		}
	}
	return nil
}

func (k *memKube) List(_ context.Context, _, kind string, labels map[string]string) ([]Object, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	var out []Object
	for _, o := range k.objs {
		if o["kind"] != kind {
			continue
		}
		have, _ := meta(o)["labels"].(map[string]any)
		match := true
		for lk, lv := range labels {
			if fmt.Sprint(have[lk]) != lv {
				match = false
			}
		}
		if match {
			out = append(out, o)
		}
	}
	return out, nil
}
