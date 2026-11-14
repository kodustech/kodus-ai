package main

import (
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

func TestRecipeEgressUsesOperatorDefaultsAndApprovalsWithoutExpandingThem(t *testing.T) {
	p := policyPusher{base: []string{"registry.npmjs.org"}}
	for _, tc := range []struct {
		name, host string
		approved   []string
		allowed    bool
	}{
		{name: "operator default", host: "registry.npmjs.org", allowed: true},
		{name: "admin approval", host: "api.example.com", approved: []string{"api.example.com"}, allowed: true},
		{name: "recipe alone is not approval", host: "api.example.com", allowed: false},
		{name: "deny list wins", host: "api.openai.com", approved: []string{"api.openai.com"}, allowed: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec, err := recipe.Parse([]byte("version: 1\negress: { allow: [" + tc.host + "] }\n"))
			if err != nil {
				t.Fatal(err)
			}
			err = p.CheckRecipeEgress(rec, tc.approved)
			if (err == nil) != tc.allowed {
				t.Fatalf("authorization outcome allowed=%t error=%v", tc.allowed, err)
			}
		})
	}
	if len(p.base) != 1 || p.base[0] != "registry.npmjs.org" {
		t.Fatal("recipe changed operator policy")
	}
}
