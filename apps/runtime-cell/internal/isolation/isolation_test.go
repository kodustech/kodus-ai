package isolation

import (
	"errors"
	"testing"
)

func TestAnUnavailableBackendSaysWhichAndWhyAndIsErrUnavailable(t *testing.T) {
	err := error(&UnavailableError{Backend: Firecracker, Reason: "no /dev/kvm"})
	if !errors.Is(err, ErrUnavailable) {
		t.Fatal("an UnavailableError is not ErrUnavailable")
	}
	if got := err.Error(); got != "isolation: firecracker is not available on this host: no /dev/kvm" {
		t.Fatalf("message %q", got)
	}
}

func TestAMachinesOnlyAddressIsItsAddressWhenNoNetworkIsNamed(t *testing.T) {
	one := Machine{Addresses: map[string]string{"kodus-c1": "10.213.4.130"}}
	if one.IP("") != "10.213.4.130" || one.IP("kodus-c1") != "10.213.4.130" || one.IP("other") != "" {
		t.Fatalf("one network: %+v", one)
	}
	two := Machine{Addresses: map[string]string{"a": "10.0.0.1", "b": "10.0.0.2"}}
	if two.IP("") != "" || two.IP("b") != "10.0.0.2" {
		t.Fatalf("two networks: %+v", two)
	}
}
