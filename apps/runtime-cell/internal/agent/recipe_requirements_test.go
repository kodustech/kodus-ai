package agent

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"reflect"
	"sync/atomic"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

func TestRecipeEgressRequiresExistingAuthority(t *testing.T) {
	for _, tc := range []struct {
		name                      string
		hosts, defaults, approved []string
		denied                    func(string) bool
		signature                 string
		want                      []string
	}{
		{name: "operator default", hosts: []string{"api.example.com"}, defaults: []string{"api.example.com"}},
		{name: "admin approved", hosts: []string{"api.example.com"}, approved: []string{"API.example.com"}},
		{name: "missing", hosts: []string{"api.example.com"}, signature: "recipe_egress_approval_required", want: []string{"api.example.com"}},
		{name: "platform wins over approval", hosts: []string{"api.openai.com"}, approved: []string{"api.openai.com"}, signature: "recipe_egress_denied", want: []string{"api.openai.com"}},
		{name: "operator denial wins over default", hosts: []string{"api.example.com"}, defaults: []string{"api.example.com"}, denied: func(string) bool { return true }, signature: "recipe_egress_denied", want: []string{"api.example.com"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			text := "version: 1\negress:\n  allow:\n"
			for _, h := range tc.hosts {
				text += "    - " + h + "\n"
			}
			r, e := recipe.Parse([]byte(text))
			if e != nil {
				t.Fatal(e)
			}
			before := append([]string(nil), tc.approved...)
			err := CheckRecipeEgress(r, tc.defaults, tc.approved, tc.denied)
			if tc.signature == "" {
				if err != nil {
					t.Fatal(err)
				}
			} else {
				var refused *RecipeEgressRefused
				if !errors.As(err, &refused) || refused.Signature != tc.signature || !reflect.DeepEqual(refused.Hosts, tc.want) {
					t.Fatalf("wrong refusal: %v", err)
				}
			}
			if !reflect.DeepEqual(before, tc.approved) {
				t.Fatal("declaration changed approval authority")
			}
		})
	}
}

type requirementValidator struct{ defaults []string }

func (v requirementValidator) CheckRecipeEgress(r *recipe.Recipe, a []string) error {
	return CheckRecipeEgress(r, v.defaults, a, nil)
}

type countedRecipeUpload struct {
	stubTransport
	count atomic.Int32
}

func (t *countedRecipeUpload) Upload(context.Context, driver.MachineRef, string, string) error {
	t.count.Add(1)
	return nil
}

// Upload may itself build the workload. A policy refusal must precede it.
func TestRecipeRequirementsStopBeforeUpload(t *testing.T) {
	for _, tc := range []struct{ name, field, want string }{
		{"unapproved", "egress: { allow: [api.example.com] }", "recipe_egress_approval_required"},
		{"denied despite approval", "egress: { allow: [api.openai.com] }", "recipe_egress_denied"},
		{"disk", "size: { cpu: 4, memory: 8gb, disk: 100gb }", "recipe_disk_unsupported"},
		{"unreserved size", "size: { cpu: 4, memory: 8gb }", "recipe_size_unreserved"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			upload := &countedRecipeUpload{}
			h := newHarness(t, func(c *Config) { c.Transport = upload; c.RecipeEgress = requirementValidator{} })
			b := h.acquireBody()
			content, _ := json.Marshal("version: 1\n" + tc.field + "\n")
			b.Recipe = &protocol.ClaimAcquireBodyRecipe{Path: ".kodus/workspace.yaml", Content: content}
			b.EgressAllow = []string{"api.openai.com"}
			if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
				t.Fatal(err)
			}
			failed := h.conn.next(t, isFailed).(*protocol.ClaimFailedBody)
			if failed.Signature != tc.want {
				t.Fatalf("signature %q, want %q", failed.Signature, tc.want)
			}
			if upload.count.Load() != 0 {
				t.Fatal("Upload/build happened before the recipe was refused")
			}
		})
	}
}
