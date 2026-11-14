package recipe

import (
	"slices"
	"testing"
)

func TestResourceDeclarationsAreNotIgnored(t *testing.T) {
	r, err := Parse([]byte("version: 1\nsize: { cpu: 4, memory: 8gb, disk: 100gb }\negress: { allow: [API.Stripe.com] }\n"))
	if err != nil {
		t.Fatal(err)
	}
	if slices.Contains(r.Unapplied(), "size") || slices.Contains(r.Unapplied(), "egress") {
		t.Fatal("declared resources are still ignored")
	}
}
func TestMalformedResourceDeclarationsFail(t *testing.T) {
	for _, line := range []string{"size: { cpu: -1, memory: 8gb }", "size: { cpu: 1.5, memory: 8gb }", "size: { cpu: 4, memory: 0gb }", "size: { cpu: 4, memory: 8gb, disk: -1gb }", "size: { cpu: 4, memory: 8gb, typo: 1 }", "egress: { allow: ['*.example.com'] }", "egress: { allow: ['https://api.example.com'] }", "egress: { allow: ['127.0.0.1'] }", "egress: { allow: ['api.example.com'], typo: true }"} {
		t.Run(line, func(t *testing.T) {
			if _, err := Parse([]byte("version: 1\n" + line + "\n")); err == nil {
				t.Fatal("malformed resource declaration accepted")
			}
		})
	}
}
