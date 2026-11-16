package main

// The roots the agent verifies its peers with (docs/runtime/self-hosted.md,
// "Three trust roots on a cell host"): the hub CA for the hub only, the
// cell-local CA for the enforcers' control ports only, and the injector's
// CA (-cell-ca-cert) for nothing the agent dials, since only machines trust
// it. Each pair shares no public key, or the cell refuses to start.

import (
	"crypto/sha256"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
)

// roots is what the agent's TLS clients verify with.
type roots struct {
	// Hub verifies the hub (WebSocket, renewal): -ca only.
	Hub *x509.CertPool
	// Local verifies the egress, resolver and injector control ports:
	// -local-ca, or Hub when Shared.
	Local *x509.CertPool
	// Shared: no -local-ca, one pool for both (dev cells, one dev CA).
	Shared bool
}

// rootFiles are the CA files the rules compare; empty ones are not set.
type rootFiles struct {
	Hub, Local, CellCA, Issuer, Observer string
}

// loadRoots builds the pools and enforces the rules: -ca and -local-ca
// share no key; the injector CA is none of the others; the enforcers are
// verified with the cell-local CA, which outside -dev must be given when the
// cell has enforcers.
func loadRoots(f rootFiles, enforcers, dev bool) (roots, error) {
	hubKeys, hub, err := readCAFile(f.Hub)
	if err != nil {
		return roots{}, fmt.Errorf("-ca: %w", err)
	}
	r := roots{Hub: hub, Local: hub, Shared: true}
	var localKeys map[[32]byte]bool
	if f.Local != "" {
		if localKeys, r.Local, err = readCAFile(f.Local); err != nil {
			return roots{}, fmt.Errorf("-local-ca: %w", err)
		}
		r.Shared = false
		if overlaps(hubKeys, localKeys) {
			return roots{}, errors.New("-ca and -local-ca share a CA key: the hub's roots and the cell's local roots must be different CAs, or an enforcer's certificate is a valid hub")
		}
	} else if enforcers && !dev {
		return roots{}, errors.New("-local-ca is required with -egress-control: the enforcers' control ports are verified with the cell-local CA, never with the hub's (-ca)")
	}
	if f.CellCA != "" {
		cellKeys, _, err := readCAFile(f.CellCA)
		if err != nil {
			return roots{}, fmt.Errorf("-cell-ca-cert: %w", err)
		}
		others := []namedKeys{{"-ca (the hub CA)", hubKeys}, {"-local-ca (the cell-local CA)", localKeys}}
		for _, o := range []struct{ flag, file string }{{"-issuer (the CA that signs the cell)", f.Issuer}, {"-observer-ca", f.Observer}} {
			if o.file == "" {
				continue
			}
			if keys, _, err := readCAFile(o.file); err == nil {
				others = append(others, namedKeys{o.flag, keys})
			}
		}
		for _, o := range others {
			if overlaps(cellKeys, o.keys) {
				return roots{}, fmt.Errorf("-cell-ca-cert is also %s: machines trust the injector's CA, which must vouch for nothing else", o.flag)
			}
		}
	}
	return r, nil
}

// namedKeys are a flag's CA keys, for the error that names it.
type namedKeys struct {
	flag string
	keys map[[32]byte]bool
}

// readCAFile is the file's certificates as a pool and the SHA-256 of each
// one's public key (a CA re-issued on the same key is the same root).
func readCAFile(path string) (map[[32]byte]bool, *x509.CertPool, error) {
	b, err := os.ReadFile(path) //nolint:gosec // G304: an operator-configured CA path
	if err != nil {
		return nil, nil, err
	}
	keys := map[[32]byte]bool{}
	pool := x509.NewCertPool()
	for {
		var blk *pem.Block
		blk, b = pem.Decode(b)
		if blk == nil {
			break
		}
		if blk.Type != "CERTIFICATE" {
			continue
		}
		c, err := x509.ParseCertificate(blk.Bytes)
		if err != nil {
			return nil, nil, fmt.Errorf("%s: %w", path, err)
		}
		keys[sha256.Sum256(c.RawSubjectPublicKeyInfo)] = true
		pool.AddCert(c)
	}
	if len(keys) == 0 {
		return nil, nil, fmt.Errorf("%s: no certificate", path)
	}
	return keys, pool, nil
}

func overlaps(a, b map[[32]byte]bool) bool {
	for k := range a {
		if b[k] {
			return true
		}
	}
	return false
}
