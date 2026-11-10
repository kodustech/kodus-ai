package recipe

import (
	"errors"
	"reflect"
	"testing"
)

const fixtureStripePin = "stripe/stripe-mock@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const fixtureMailPin = "axllent/mailpit@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

func TestFakeDeclarationsAreClosedAndReproducible(t *testing.T) {
	rec, err := Parse([]byte("version: 1\nfakes:\n  stripe: { image: " + fixtureStripePin + ", env: { STRIPE_API_BASE: 'http://stripe-mock:12111' } }\n  email: { image: " + fixtureMailPin + " }\n"))
	if err != nil {
		t.Fatal(err)
	}
	want := []FakeService{{Kind: "email", Service: "mailpit", Image: fixtureMailPin, Env: map[string]string{}}, {Kind: "stripe", Service: "stripe-mock", Image: fixtureStripePin, Env: map[string]string{"STRIPE_API_BASE": "http://stripe-mock:12111"}}}
	if !reflect.DeepEqual(rec.FakeServices(), want) {
		t.Fatalf("fakes: %+v", rec.FakeServices())
	}
	rec.FakeServices()[1].Env["STRIPE_API_BASE"] = "changed"
	if !reflect.DeepEqual(rec.FakeServices(), want) {
		t.Fatal("caller mutated recipe state")
	}
	if err := rec.RequirePinnedFakes(); err != nil {
		t.Fatal(err)
	}
	for _, key := range rec.Unapplied() {
		if key == "fakes" {
			t.Fatal("supported declared fake is still silently unapplied")
		}
	}
}
func TestLegacyFakeAliasRequiresExplicitPinAtExecution(t *testing.T) {
	rec, err := Parse([]byte("version: 1\nfakes: { stripe: True, email: { image: mailpit } }\n"))
	if err != nil {
		t.Fatal(err)
	}
	var requirement *FakeRequirementError
	if !errors.As(rec.RequirePinnedFakes(), &requirement) || requirement.Code != "fake_image_pin_required" {
		t.Fatal("legacy alias authorized a mutable image")
	}
}
func TestUnsafeFakeDeclarationsAreRefused(t *testing.T) {
	for _, body := range []string{
		"fakes: { arbitrary: { image: alpine } }",
		"fakes: { stripe: { image: evil/stripe-mock } }",
		"fakes: { stripe: { image: stripe/stripe-mock:latest } }",
		"fakes: { stripe: { image: stripe-mock, privileged: true } }",
		"fakes: { stripe: false }",
		"fakes: { stripe: { image: stripe-mock, env: { NODE_OPTIONS: '--require /tmp/x' } } }",
		"fakes: { stripe: { image: stripe-mock, env: { API_TOKEN: customer-secret } } }",
		"fakes: { stripe: { image: stripe-mock, env: { SAME: a } }, email: { image: mailpit, env: { SAME: b } } }",
		"services: { compose: { env: { SAME: a } } }\nfakes: { stripe: { image: stripe-mock, env: { SAME: b } } }",
		"fakes: { stripe: { image: stripe-mock, env: { SAFE: 12 } } }",
	} {
		t.Run(body, func(t *testing.T) {
			if _, err := Parse([]byte("version: 1\n" + body + "\n")); err == nil {
				t.Fatal("unsafe fake accepted")
			}
		})
	}
}
