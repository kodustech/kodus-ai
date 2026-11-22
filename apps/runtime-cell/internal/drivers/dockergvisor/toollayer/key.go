package toollayer

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
)

// KeyInput is everything that makes one layer different from another except
// the org, which is the directory (design 4.1).
type KeyInput struct {
	Installer string
	// Argv is the install argv after the API's plan, so --ignore-scripts is part of it.
	Argv        []string
	Binary      string
	ImageDigest string
	// Arch is the cell's GOARCH.
	Arch     string
	Registry string
}

type keyRecord struct {
	LayerFormat int      `json:"layerFormat"`
	Installer   string   `json:"installer"`
	Argv        []string `json:"argv"`
	Binary      string   `json:"binary"`
	ImageDigest string   `json:"imageDigest"`
	Arch        string   `json:"arch"`
	Registry    string   `json:"registry"`
}

// ComputeKey is the sha256 of the canonical record. It refuses without an
// image digest (U6): no digest, no layers, and the caller installs as today.
func ComputeKey(in KeyInput) (string, error) {
	if !imageDigestRe.MatchString(in.ImageDigest) {
		return "", ErrNoImageDigest
	}
	switch {
	case in.Installer == "":
		return "", errors.New("toollayer: key needs an installer")
	case len(in.Argv) == 0:
		return "", errors.New("toollayer: key needs the install argv")
	case in.Binary == "":
		return "", errors.New("toollayer: key needs the binary name")
	case in.Arch == "":
		return "", errors.New("toollayer: key needs the architecture")
	case in.Registry == "":
		return "", errors.New("toollayer: key needs the registry host")
	}
	// JSON gives every argv element its own boundary.
	raw, err := json.Marshal(keyRecord{LayerFormat, in.Installer, in.Argv, in.Binary, in.ImageDigest, in.Arch, in.Registry})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}
